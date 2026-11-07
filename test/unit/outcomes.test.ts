/**
 * Payment outcomes, postponed Mollie updates and lifecycle intents: each test
 * reproduces a finding of the review of the resumable lifecycle (a70dd63).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { toMollieDate } from "../../src/utils";
import { PLANS, settle, setup, type TestEnv } from "../helpers/setup";

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

/** past_due after a failed renewal; returns fresh sign-in headers (sessions expire). */
async function delinquent(env: TestEnv) {
	const subscription = await subscribe(env);
	travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
	const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
	await env.webhook(`id=${failed.id}`);
	const { headers } = await env.signInWithTestUser();
	return { subscription, headers };
}

async function recoveryPayment(env: TestEnv, headers: Headers) {
	await env.api.upgradeSubscription({ body: { plan: "starter" }, headers });
	return [...env.fake.payments.values()].at(-1)!;
}

/**
 * Plans that can pause the next lookup: lets a test stop one delivery right
 * after it recorded the payment, while another delivery runs.
 */
function pausablePlans() {
	let pause: { reached: () => void; gate: Promise<void> } | null = null;
	return {
		plans: async () => {
			const current = pause;
			if (current) {
				pause = null;
				current.reached();
				await current.gate;
			}
			return PLANS;
		},
		pauseNext() {
			let release!: () => void;
			let reached!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const paused = new Promise<void>((resolve) => {
				reached = resolve;
			});
			pause = { reached, gate };
			return { paused, release };
		},
	};
}

const refundedIds = (env: TestEnv) => [...env.fake.refunds.values()].map((r) => r.paymentId);

describe("duplicate payments are refunded exactly when they are duplicates", () => {
	it("retries a duplicate's refund that failed, from the sync", async () => {
		const onDuplicatePayment = vi.fn(async () => {});
		const env = await setup({ subscription: { onDuplicatePayment } });
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);

		env.fake.failNext("refunds.create", new TypeError("fetch failed"));
		const response = await env.webhook(`id=${second.payment.id}`);
		expect(response.status).toBeGreaterThanOrEqual(500);
		expect(refundedIds(env)).toEqual([]);

		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([second.payment.id]);
		await env.webhook(`id=${second.payment.id}`);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([second.payment.id]);
		const records = await env.payments();
		expect(records.find((r) => r.molliePaymentId === second.payment.id)?.outcome).toBe("refunded");
		expect(records.find((r) => r.molliePaymentId === first.payment.id)?.outcome).toBe("applied");
		await settle();
		expect(onDuplicatePayment).toHaveBeenCalledTimes(1);
	});

	it("does not refund a recovery payment that a concurrent delivery of it applied", async () => {
		const pausable = pausablePlans();
		const env = await setup({ subscription: { plans: pausable.plans } });
		const { subscription, headers } = await delinquent(env);
		const recovery = await recoveryPayment(env, headers);
		env.fake.completePayment(recovery.id, "paid");

		// Delivery A records the payment as paid, then stalls; B applies it.
		const { paused, release } = pausable.pauseNext();
		const deliveryA = env.webhook(`id=${recovery.id}`);
		await paused;
		await env.webhook(`id=${recovery.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");
		release();
		await deliveryA;

		expect(refundedIds(env)).toEqual([]);
		const row = await env.subscription(subscription.id);
		expect(row).toMatchObject({ status: "active", appliedPaymentId: recovery.id });
	});

	it("refunds the losing one of two checkouts paid at the same time", async () => {
		const pausable = pausablePlans();
		const env = await setup({ subscription: { plans: pausable.plans } });
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");

		// The second checkout's delivery read the row while it was incomplete.
		const { paused, release } = pausable.pauseNext();
		const late = env.webhook(`id=${second.payment.id}`);
		await paused;
		await env.webhook(`id=${first.payment.id}`);
		release();
		await late;

		expect(refundedIds(env)).toEqual([second.payment.id]);
		expect((await env.subscriptions())[0]).toMatchObject({ status: "active", plan: "starter" });
	});

	it("does not invoice a duplicate that is refunded", async () => {
		const env = await setup({
			subscription: { tax: { calculate: () => ({ rate: "21.00", country: "NL" }) } },
			options: {
				salesInvoices: {
					enabled: true,
					getRecipient: () => ({
						type: "consumer",
						givenName: "Test",
						familyName: "User",
						email: "test@example.com",
						streetAndNumber: "Keizersgracht 1",
						postalCode: "1015 CJ",
						city: "Amsterdam",
						country: "NL",
						locale: "nl_NL",
					}),
				},
			},
		});
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);
		await env.webhook(`id=${second.payment.id}`);
		await settle();
		await syncMollieSubscriptions(env.auth as never);
		const invoiced = [...env.fake.salesInvoices.values()].map(
			(invoice: any) => (invoice.request ?? invoice).paymentDetails?.sourceReference,
		);
		expect(invoiced).toEqual([first.payment.id]);
	});
});

describe("Mollie follows every change, and never collects twice for the same time", () => {
	it("does not replace a Mollie subscription while one of its charges is in progress", async () => {
		let rate = "21.00";
		const env = await setup({ subscription: { tax: { calculate: () => ({ rate }) } } });
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		const charge = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "open");
		rate = "9.00";

		await syncMollieSubscriptions(env.auth as never);
		const customerId = subscription.mollieCustomerId!;
		expect(env.fake.activeSubscriptionsFor(customerId).map((s) => s.id)).toEqual([
			subscription.mollieSubscriptionId,
		]);
		expect((await env.subscription(subscription.id)).mollieSyncNeeded).toBe(true);

		env.fake.completePayment(charge.id, "paid");
		await env.webhook(`id=${charge.id}`);
		const row = await env.subscription(subscription.id);
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
		const active = env.fake.activeSubscriptionsFor(customerId);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]).toMatchObject({
			amount: { value: "10.85" },
			startDate: toMollieDate(new Date(row.periodEnd!)),
		});
		expect(row.mollieSyncNeeded).toBe(false);
		expect(refundedIds(env)).toEqual([]);
	});

	it("cancels a lost replacement when the plan change is undone", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		env.fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		// The starter replacement exists at Mollie but was never recorded; undo.
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });

		const row = await env.subscription(subscription.id);
		expect(row.pendingPlan).toBeFalsy();
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]).toMatchObject({ metadata: { plan: "business" } });
	});

	it("brings Mollie in line after a recovery right away, not at the next period end", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		const recovery = await recoveryPayment(env, headers);
		env.fake.completePayment(recovery.id, "paid");
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.webhook(`id=${recovery.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");
		// The old Mollie subscription, on the old mandate, is still running.
		expect(env.fake.subscriptions.get(subscription.mollieSubscriptionId!)?.status).toBe("active");

		travel(Date.now() + 2 * 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		const row = await env.subscription(subscription.id);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]?.mandateId).toBe(row.mollieMandateId);
		expect(row.mollieSyncNeeded).toBe(false);
	});

	it("never resumes billing after a cancellation that was interrupted at Mollie", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		// Mollie cancels, but the response is lost and checking it fails too.
		env.fake.loseNextResponse("subscriptions.cancel");
		env.fake.failNext("subscriptions.get", new TypeError("fetch failed"));
		await env.api
			.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers })
			.catch(() => {});

		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "active",
			cancelAtPeriodEnd: true,
		});
	});

	it("keeps taxing with the customer type chosen at checkout", async () => {
		const env = await setup({
			subscription: {
				tax: {
					calculate: ({ customerType }) =>
						customerType === "user"
							? { rate: "21.00" }
							: { rate: "0.00", reverseCharge: true, country: "BE" },
				},
			},
		});
		const subscription = await subscribe(env);
		// The user record is gone (e.g. deleted); the subscription runs on, and
		// its price must not turn into a business price.
		await env.context.adapter.delete({
			model: "user",
			where: [{ field: "id", value: subscription.referenceId }],
		});
		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => [s.id, s.amount.value])).toEqual([
			[subscription.mollieSubscriptionId, "12.04"],
		]);
	});
});

describe("re-check of 94c806f: cancellation, coverage and compensation", () => {
	it("keeps retrying a failed cancellation after the period has ended", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		env.fake.failNext("subscriptions.cancel", new TypeError("fetch failed"));
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		expect(env.fake.subscriptions.get(subscription.mollieSubscriptionId!)?.status).toBe("active");

		// The first sync only runs after the period ended.
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
		const row = await env.subscription(subscription.id);
		expect(row).toMatchObject({ status: "canceled", mollieSyncNeeded: false });
	});

	it("stops a lost replacement when the customer cancels", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "business");
		env.fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toHaveLength(1);

		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
	});

	it("applies a renewal whose webhook is late before replacing billing", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		// Mollie charged the renewal; its webhook has not arrived.
		env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		const { headers } = await env.signInWithTestUser();
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers });

		const row = await env.subscription(subscription.id);
		expect(row.plan).toBe("business");
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]?.startDate).toBe(toMollieDate(new Date(row.periodEnd!)));
		expect(refundedIds(env)).toEqual([]);
	});

	it("does not adopt a replacement made for a period a renewal just extended", async () => {
		let rate = "21.00";
		let pause: (() => Promise<void>) | null = null;
		const env = await setup({
			subscription: {
				tax: {
					calculate: async () => {
						const current = pause;
						pause = null;
						if (current) await current();
						return { rate };
					},
				},
			},
		});
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		rate = "9.00";

		let release!: () => void;
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		pause = () =>
			new Promise<void>((resolve) => {
				release = resolve;
				reached();
			});
		const sync = syncMollieSubscriptions(env.auth as never);
		await paused;
		// While the sync works out the new price, the renewal is paid.
		const charge = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await env.webhook(`id=${charge.id}`);
		release();
		await sync;

		const row = await env.subscription(subscription.id);
		expect(new Date(row.periodEnd!).getTime()).toBeGreaterThan(periodEnd.getTime());
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active.map((s) => s.id)).toEqual([row.mollieSubscriptionId]);
		expect(active[0]).toMatchObject({
			amount: { value: "10.85" },
			startDate: toMollieDate(new Date(row.periodEnd!)),
		});
		expect(refundedIds(env)).toEqual([]);
	});

	it("refunds a pro-rata charge whose upgrade lost its lock, even if the refund fails at first", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		let reached!: () => void;
		const charged = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		env.fake.afterNextCreate("payments.create", async () => {
			reached();
			await gate;
		});
		const upgrade = env.api
			.upgradeSubscription({ body: { plan: "business" }, headers: env.headers })
			.catch((error: unknown) => error);
		await charged;
		// The upgrade stalls after charging, past its lease; another change takes over.
		travel(Date.now() + 3 * 60_000);
		const { headers } = await env.signInWithTestUser();
		await env.api.upgradeSubscription({ body: { plan: "yearly" }, headers });
		release();
		await upgrade;

		const proration = [...env.fake.payments.values()].find(
			(p) => (p.metadata as { purpose?: string }).purpose === "proration",
		)!;
		expect(refundedIds(env)).toEqual([]);
		// The charge settles later; its first refund attempt fails.
		if (proration.status !== "paid") env.fake.completePayment(proration.id, "paid");
		env.fake.failNext("refunds.create", new TypeError("fetch failed"));
		await env.webhook(`id=${proration.id}`);
		expect(refundedIds(env)).toEqual([]);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([proration.id]);
		expect((await env.subscription(subscription.id)).plan).toBe("starter");
	});

	it("refunds a pro-rata charge whose upgrade was never recorded (process stopped)", async () => {
		const env = await setup();
		const subscription = await subscribe(env, "starter");
		// Charged by an upgrade whose process stopped before changing the plan.
		const proration = await env.fake.client.payments.create({
			idempotencyKey: "crashed-upgrade",
			paymentRequest: {
				amount: { currency: "EUR", value: "39.05" },
				description: "business: upgrade for the rest of this period",
				sequenceType: "recurring",
				customerId: subscription.mollieCustomerId!,
				mandateId: subscription.mollieMandateId!,
				metadata: { subscriptionId: subscription.id, plan: "business", purpose: "proration" },
			},
		} as never);
		env.fake.completePayment(proration.id, "paid");
		await env.webhook(`id=${proration.id}`);
		expect(refundedIds(env)).toEqual([]);

		travel(Date.now() + 15 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(refundedIds(env)).toEqual([proration.id]);
		expect((await env.subscription(subscription.id)).plan).toBe("starter");
	});

	it("does not let a recovery payment undo a later cancellation", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		const recovery = await recoveryPayment(env, headers);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers });

		env.fake.completePayment(recovery.id, "paid");
		await env.webhook(`id=${recovery.id}`);
		const row = await env.subscription(subscription.id);
		expect(row.cancelAtPeriodEnd).toBe(true);
		expect(row.status).not.toBe("active");
		expect(refundedIds(env)).toEqual([recovery.id]);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([]);
	});

	it("starts a new subscription, not a recovery, after a delinquent one was canceled", async () => {
		const env = await setup();
		const { subscription, headers } = await delinquent(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers });
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers });

		expect((await env.subscription(subscription.id)).status).toBe("canceled");
		const latest = [...env.fake.payments.values()].at(-1)!;
		expect(metadataPurpose(latest)).toBe("checkout");
		expect((latest.metadata as { subscriptionId: string }).subscriptionId).not.toBe(
			subscription.id,
		);
	});
});

function metadataPurpose(payment: { metadata?: unknown }) {
	return (payment.metadata as { purpose?: string } | undefined)?.purpose;
}
