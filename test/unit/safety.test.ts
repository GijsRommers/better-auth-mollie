import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { AUTH_URL, settle, setup, type TestEnv } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

function travel(to: Date | number) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(to);
}

async function subscribe(env: TestEnv, plan = "starter") {
	const { payment } = await env.checkout(plan);
	env.fake.completePayment(payment.id, "paid");
	await env.webhook(`id=${payment.id}`);
	const [subscription] = await env.subscriptions();
	return subscription!;
}

describe("prices cannot be changed from the outside", () => {
	it("ignores reserved keys in caller metadata", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter", {
			metadata: {
				grossAmount: "1.00",
				netAmount: "1.00",
				vatAmount: "0.00",
				vatRate: "0.00",
				purpose: "recovery",
				plan: "business",
				trial: true,
				trialDays: 365,
				note: "kept",
			},
		});
		expect(payment.metadata).toMatchObject({ plan: "starter", purpose: "checkout", trial: false });
		expect(payment.metadata).not.toHaveProperty("grossAmount");
		expect(payment.metadata).toHaveProperty("note", "kept");

		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		const [mollieSubscription] = [...env.fake.subscriptions.values()];
		expect(mollieSubscription?.amount.value).toBe("9.95");
		expect((await env.subscriptions())[0]?.status).toBe("active");
	});
});

describe("renewals only pay for their own period", () => {
	it("does not let an old paid renewal reactivate a past-due subscription", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const mollieId = subscription.mollieSubscriptionId!;
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const january = env.fake.chargeSubscription(mollieId, "paid");
		await env.webhook(`id=${january.id}`);
		const renewed = await env.subscription(subscription.id);

		travel(new Date(renewed.periodEnd!).getTime() + 3_600_000);
		const february = env.fake.chargeSubscription(mollieId, "failed");
		await env.webhook(`id=${february.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");

		// January's payment is delivered again, and the cron re-reads it too.
		await env.webhook(`id=${january.id}`);
		await syncMollieSubscriptions(env.auth as never);
		const after = await env.subscription(subscription.id);
		expect(after.status).toBe("past_due");
		expect(after.periodEnd).toEqual(renewed.periodEnd);
	});
});

describe("concurrent changes leave exactly one chargeable Mollie subscription", () => {
	/** Pauses the next create of `method` after Mollie stored it, until released. */
	function pauseAfterCreate(env: TestEnv, method: string) {
		let release!: () => void;
		let reached!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		env.fake.afterNextCreate(method, async () => {
			reached();
			await gate;
		});
		return { paused, release };
	}

	it("serializes plan changes: a racing change neither adds a subscription nor a charge", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		// A has canceled the old Mollie subscription and created its replacement,
		// but has not recorded it yet.
		const pause = pauseAfterCreate(env, "subscriptions.create");
		const a = env.api
			.upgradeSubscription({ body: { plan: "business" }, headers: env.headers })
			.catch((error: unknown) => error);
		await pause.paused;
		// B changes to another plan meanwhile.
		const b = await env.api
			.upgradeSubscription({ body: { plan: "yearly" }, headers: env.headers })
			.catch((error: unknown) => error);
		pause.release();
		await a;

		expect(b).toMatchObject({ body: { code: "OPERATION_IN_PROGRESS" } });
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		const row = await env.subscription(subscription.id);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		const prorations = [...env.fake.payments.values()].filter(
			(p) => (p.metadata as { purpose?: string }).purpose === "proration",
		);
		expect(prorations).toHaveLength(1);
	});

	it("keeps the restored subscription when restores race", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/" }, headers: env.headers });
		// A created the new Mollie subscription but has not recorded it yet.
		const pause = pauseAfterCreate(env, "subscriptions.create");
		const a = env.api
			.restoreSubscription({ body: {}, headers: env.headers })
			.catch((e: unknown) => e);
		await pause.paused;
		const b = await env.api
			.restoreSubscription({ body: {}, headers: env.headers })
			.catch((e: unknown) => e);
		pause.release();
		await a;

		expect(b).toMatchObject({ body: { code: "OPERATION_IN_PROGRESS" } });
		const row = await env.subscription(subscription.id);
		expect(row.cancelAtPeriodEnd).toBe(false);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
	});

	it("cancels the Mollie subscription of a first payment that lost the activation race", async () => {
		const env = await setup();
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await Promise.all([
			env.webhook(`id=${first.payment.id}`),
			env.webhook(`id=${second.payment.id}`),
		]);
		const [row] = await env.subscriptions();
		expect(row?.status).toBe("active");
		const active = env.fake.activeSubscriptionsFor(row!.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row!.mollieSubscriptionId]);
	});

	it("sweeps an orphaned Mollie subscription before it can charge", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		// A replacement created by a change that crashed before recording it.
		const orphan = await env.fake.client.subscriptions.create({
			customerId: subscription.mollieCustomerId!,
			idempotencyKey: "lost",
			subscriptionRequest: {
				amount: { currency: "EUR", value: "49.00" },
				interval: "1 month",
				description: "orphan",
				metadata: { subscriptionId: subscription.id },
			},
		} as never);
		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.subscriptions.get(orphan.id)?.status).toBe("canceled");
		expect(env.fake.subscriptions.get(subscription.mollieSubscriptionId!)?.status).toBe("active");
	});
});

describe("checkouts", () => {
	it("starts a new subscription row when the old checkout expired in the meantime", async () => {
		const env = await setup();
		const first = await env.checkout("starter");
		env.fake.completePayment(first.payment.id, "failed"); // webhook not delivered yet
		const second = await env.checkout("starter");
		expect(second.payment.id).not.toBe(first.payment.id);

		const rows = await env.subscriptions();
		expect(rows.map((r) => r.status)).toEqual(["incomplete_expired", "incomplete"]);
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${second.payment.id}`);
		expect((await env.subscriptions())[1]?.status).toBe("active");
	});

	it("expires a failed checkout even if the process stopped right after recording it", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "failed");
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: payment.id }],
			update: { status: "failed" },
		});
		await env.webhook(`id=${payment.id}`);
		expect((await env.subscriptions())[0]?.status).toBe("incomplete_expired");
	});

	it("does not let another user sync someone else's checkout from the redirect URL", async () => {
		const env = await setup();
		env.authorizeReference.mockResolvedValue(false);
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await env.auth.api.signUpEmail({
			body: { email: "other@test.com", password: "password1234", name: "Other" },
		});
		const other = await env.signInWithUser("other@test.com", "password1234");
		const response = await env.auth.handler(
			new Request(payment.redirectUrl!, { headers: other.headers }),
		);
		expect(response.status).toBe(302);
		expect((await env.subscriptions())[0]?.status).toBe("incomplete");
		// The owner's own redirect does sync it.
		await env.auth.handler(new Request(payment.redirectUrl!, { headers: env.headers }));
		expect((await env.subscriptions())[0]?.status).toBe("active");
	});

	it("points the redirect at the plugin's success endpoint", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		expect(payment.redirectUrl?.startsWith(`${AUTH_URL}/subscription/success?`)).toBe(true);
	});
});

describe("customer details", () => {
	it("keeps the Mollie customer in sync with the user's latest name and email", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		await env.api.updateUser({ body: { name: "Renamed User" }, headers: env.headers });
		await settle();
		expect(env.fake.customers.get(payment.customerId!)?.name).toBe("Renamed User");
	});
});
