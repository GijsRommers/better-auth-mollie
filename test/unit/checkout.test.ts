import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { AUTH_URL, gate, PLANS, settle, setup, travel } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

describe("subscription.upgrade (new subscription)", () => {
	it("creates a Mollie customer and a first payment, and returns its checkout URL", async () => {
		const env = await setup();
		const { result, payment } = await env.checkout("starter", { metadata: { campaign: "fall" } });

		expect(result).toEqual({ url: payment.links.checkout?.href, redirect: true });
		expect(payment).toMatchObject({
			sequenceType: "first",
			amount: { currency: "EUR", value: "9.95" },
			cancelUrl: "http://app.example.com/pricing",
			webhookUrl: `${AUTH_URL}/mollie/webhook`,
		});
		expect(payment.redirectUrl).toMatch(
			new RegExp(`^${AUTH_URL}/subscription/success\\?subscriptionId=.+&callbackURL=%2Fdashboard$`),
		);

		const [subscription] = await env.subscriptions();
		expect(subscription).toMatchObject({
			referenceId: env.user.id,
			plan: "starter",
			status: "incomplete",
			mollieCustomerId: payment.customerId,
		});
		expect(payment.metadata).toMatchObject({
			subscriptionId: subscription!.id,
			referenceId: env.user.id,
			plan: "starter",
			trial: false,
			campaign: "fall",
		});
		const customer = env.fake.customers.get(payment.customerId!);
		expect(customer).toMatchObject({ email: env.user.email, metadata: { userId: env.user.id } });
		const user = await env.context.adapter.findOne<{ mollieCustomerId: string }>({
			model: "user",
			where: [{ field: "id", value: env.user.id }],
		});
		expect(user?.mollieCustomerId).toBe(customer!.id);
	});

	it("journals every Mollie call it makes", async () => {
		const env = await setup();
		await env.checkout("starter");
		const operations = (await env.operations()).filter((op) => op.kind !== "lifecycle_lock");
		expect(operations.map((op) => [op.kind, op.status]).sort()).toEqual([
			["create_customer", "succeeded"],
			["create_first_payment", "succeeded"],
		]);
		const [call] = env.fake.callsTo("payments.create");
		const key = (call!.args[0] as { idempotencyKey: string }).idempotencyKey;
		expect(operations.map((op) => op.idempotencyKey)).toContain(key);
	});

	it("reuses an open checkout instead of creating a second payment", async () => {
		const env = await setup();
		const first = await env.checkout("starter");
		const second = await env.checkout("starter");
		expect(second.result.url).toBe(first.result.url);
		expect(env.fake.payments.size).toBe(1);
		expect(env.fake.customers.size).toBe(1);
	});

	it("starts a new checkout when the plan changes before paying", async () => {
		const env = await setup();
		await env.checkout("starter");
		const { payment } = await env.checkout("business");
		expect(env.fake.payments.size).toBe(2);
		expect(payment.amount.value).toBe("49.00");
		const subscriptions = await env.subscriptions();
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]?.plan).toBe("business");
	});

	it("does not recover a lost checkout in another currency", async () => {
		let currency = "EUR";
		const env = await setup({
			subscription: {
				plans: async () =>
					PLANS.map((plan) => (plan.name === "starter" ? { ...plan, currency } : plan)),
			},
		});
		env.fake.loseNextResponse("payments.create");
		await expect(env.checkout("starter")).rejects.toBeTruthy();
		currency = "USD";
		const { result, payment } = await env.checkout("starter");
		expect(payment.amount.currency).toBe("USD");
		expect(result).toMatchObject({ url: payment.links.checkout?.href });
	});

	it("creates no checkout for a row that changed while getFirstPaymentParams ran", async () => {
		let stall: ReturnType<typeof gate> | null = null;
		const env = await setup({
			subscription: {
				getFirstPaymentParams: async () => {
					await stall?.hold();
					return {};
				},
			},
		});
		env.fake.failNext("payments.create", Object.assign(new Error("invalid"), { statusCode: 422 }));
		await expect(env.checkout("starter")).rejects.toBeTruthy();
		const [row] = await env.subscriptions();
		travel(Date.now() + 25 * 3_600_000);

		stall = gate();
		const retry = env.checkout("starter").catch((error: unknown) => error);
		await stall.paused;
		// The lock lease runs out; the sync expires the abandoned row meanwhile.
		travel(Date.now() + 5 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(row!.id)).status).toBe("incomplete_expired");
		stall.release();
		await retry;

		const forRow = [...env.fake.payments.values()].filter(
			(payment) => (payment.metadata as { subscriptionId?: string }).subscriptionId === row!.id,
		);
		expect(forRow).toEqual([]);
	});

	it("creates no checkout for a row that changed while its journal entry was written", async () => {
		const env = await setup();
		env.fake.failNext("payments.create", Object.assign(new Error("invalid"), { statusCode: 422 }));
		await expect(env.checkout("starter")).rejects.toBeTruthy();
		const [row] = await env.subscriptions();
		travel(Date.now() + 25 * 3_600_000);

		const adapter = env.context.adapter as any;
		const original = adapter.create.bind(adapter);
		const stall = gate();
		let armed = true;
		adapter.create = async (args: any) => {
			if (armed && args.model === "mollieOperation" && args.data?.kind === "create_first_payment") {
				armed = false;
				await stall.hold();
			}
			return original(args);
		};
		const retry = env.checkout("starter").catch((error: unknown) => error);
		await stall.paused;
		travel(Date.now() + 5 * 60_000);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(row!.id)).status).toBe("incomplete_expired");
		stall.release();
		expect(await retry).toBeInstanceOf(Error);
		adapter.create = original;

		const forRow = [...env.fake.payments.values()].filter(
			(payment) => (payment.metadata as { subscriptionId?: string }).subscriptionId === row!.id,
		);
		expect(forRow).toEqual([]);
	});

	it("rejects unknown plans", async () => {
		const env = await setup();
		await expect(env.checkout("platinum")).rejects.toMatchObject({
			body: { code: "SUBSCRIPTION_PLAN_NOT_FOUND" },
		});
	});

	it("requires a verified email when configured", async () => {
		const env = await setup({ subscription: { requireEmailVerification: true } });
		await expect(env.checkout("starter")).rejects.toMatchObject({
			body: { code: "EMAIL_VERIFICATION_REQUIRED" },
		});
	});

	it("does not let callers override amounts or URLs through getFirstPaymentParams", async () => {
		const env = await setup({
			subscription: {
				getFirstPaymentParams: () =>
					({
						method: "creditcard",
						amount: { currency: "EUR", value: "0.01" },
						webhookUrl: "https://evil.example/webhook",
					}) as never,
			},
		});
		const { payment } = await env.checkout("starter");
		expect(payment.method).toBe("creditcard");
		expect(payment.amount.value).toBe("9.95");
		expect(payment.webhookUrl).toBe(`${AUTH_URL}/mollie/webhook`);
	});
});

describe("first payment → activation", () => {
	it("activates on a paid first payment and schedules the Mollie subscription after the paid period", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");

		const response = await env.webhook(`id=${payment.id}`);
		expect(response.status).toBe(200);

		const [subscription] = await env.subscriptions();
		const mollieSubscription = [...env.fake.subscriptions.values()][0]!;
		expect(subscription).toMatchObject({
			status: "active",
			mollieSubscriptionId: mollieSubscription.id,
			mollieMandateId: env.fake.payments.get(payment.id)!.mandateId,
			cancelAtPeriodEnd: false,
			trialEnd: null,
		});
		const periodEnd = new Date(subscription!.periodEnd!);
		expect(periodEnd.getUTCHours()).toBe(0);
		expect(mollieSubscription).toMatchObject({
			amount: { currency: "EUR", value: "9.95" },
			interval: "1 month",
			startDate: periodEnd.toISOString().slice(0, 10),
			mandateId: subscription!.mollieMandateId,
			webhookUrl: `${AUTH_URL}/mollie/webhook`,
			metadata: { subscriptionId: subscription!.id, plan: "starter" },
		});
		expect(mollieSubscription.description).toContain(subscription!.id);

		await settle();
		expect(env.hooks.onSubscriptionActivated).toHaveBeenCalledTimes(1);
		expect(env.hooks.onPaymentPaid).toHaveBeenCalledTimes(1);
		expect(env.hooks.onPaymentPaid.mock.calls[0]![0]).toMatchObject({
			isVerification: false,
			record: { status: "paid", sequenceType: "first" },
		});
	});

	it("is idempotent: repeated webhooks neither duplicate the subscription nor the hooks", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await Promise.all([
			env.webhook(`id=${payment.id}`),
			env.webhook(`id=${payment.id}`),
			env.webhook(`id=${payment.id}`),
		]);
		await env.webhook(`id=${payment.id}`);
		await settle();
		expect(env.fake.subscriptions.size).toBe(1);
		expect(env.hooks.onSubscriptionActivated).toHaveBeenCalledTimes(1);
		expect(env.hooks.onPaymentPaid).toHaveBeenCalledTimes(1);
		expect(await env.payments()).toHaveLength(1);
	});

	it("activates through the redirect endpoint before the webhook arrives", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");

		const response = await env.auth.handler(
			new Request(payment.redirectUrl!, { headers: env.headers }),
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("http://app.example.com/dashboard");
		const [subscription] = await env.subscriptions();
		expect(subscription?.status).toBe("active");

		await env.webhook(`id=${payment.id}`);
		expect(env.fake.subscriptions.size).toBe(1);
	});

	it("redirect endpoint refuses foreign callback URLs", async () => {
		// Better Auth skips origin checks in tests unless told otherwise.
		const env = await setup({ auth: { advanced: { disableOriginCheck: false } } });
		const response = await env.auth.handler(
			new Request(
				`${AUTH_URL}/subscription/success?callbackURL=${encodeURIComponent("https://evil.example")}`,
				{ headers: env.headers },
			),
		);
		expect(response.status).toBe(403);
	});

	it("gives a 14-day trial: verification payment, trialing, Mollie subscription from trial end", async () => {
		const env = await setup();
		const { payment } = await env.checkout("pro");
		expect(payment.amount.value).toBe("0.02");
		expect(payment.metadata).toMatchObject({ trial: true, trialDays: 14 });
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);

		const [subscription] = await env.subscriptions();
		const paidAt = new Date(env.fake.payments.get(payment.id)!.paidAt!);
		const trialEnd = new Date(subscription!.trialEnd!);
		expect(subscription).toMatchObject({ status: "trialing" });
		expect(trialEnd.getTime() - paidAt.getTime()).toBeGreaterThanOrEqual(14 * 86_400_000);
		expect(trialEnd.getTime() - paidAt.getTime()).toBeLessThan(15 * 86_400_000);
		expect(subscription!.periodEnd).toEqual(subscription!.trialEnd);
		const mollieSubscription = [...env.fake.subscriptions.values()][0]!;
		expect(mollieSubscription).toMatchObject({
			amount: { value: "29.00" },
			startDate: trialEnd.toISOString().slice(0, 10),
		});
		await settle();
		expect(env.hooks.onPaymentPaid.mock.calls[0]![0]).toMatchObject({ isVerification: true });
	});

	it("only gives a reference one trial", async () => {
		const env = await setup();
		const { payment } = await env.checkout("pro");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		const [subscription] = await env.subscriptions();
		// Simulate the trial subscription having ended.
		await env.context.adapter.update({
			model: "subscription",
			where: [{ field: "id", value: subscription!.id }],
			update: { status: "canceled" },
		});
		const second = await env.checkout("pro");
		expect(second.payment.amount.value).toBe("29.00");
		expect(second.payment.metadata).toMatchObject({ trial: false });
	});

	it("uses the configured verification amount", async () => {
		const env = await setup({ subscription: { verificationAmount: "0.00" } });
		const { payment } = await env.checkout("pro");
		expect(payment.amount.value).toBe("0.00");
	});

	it("expires the checkout when the first payment fails, and fires onPaymentFailed", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "failed");
		await env.webhook(`id=${payment.id}`);
		const [subscription] = await env.subscriptions();
		expect(subscription?.status).toBe("incomplete_expired");
		expect(env.fake.subscriptions.size).toBe(0);
		await settle();
		expect(env.hooks.onPaymentFailed).toHaveBeenCalledTimes(1);
		expect(env.hooks.onSubscriptionActivated).not.toHaveBeenCalled();
	});

	it("keeps the checkout open while another attempt is still payable", async () => {
		const env = await setup();
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "expired");
		await env.webhook(`id=${first.payment.id}`);
		expect((await env.subscriptions())[0]?.status).toBe("incomplete");

		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${second.payment.id}`);
		expect((await env.subscriptions())[0]).toMatchObject({ status: "active", plan: "business" });
	});

	it("activates the plan that was actually paid for, even after switching checkouts", async () => {
		const env = await setup();
		const first = await env.checkout("starter");
		await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);
		const [subscription] = await env.subscriptions();
		expect(subscription).toMatchObject({ status: "active", plan: "starter" });
		expect([...env.fake.subscriptions.values()][0]?.amount.value).toBe("9.95");
		await settle();
		expect(env.hooks.onSubscriptionActivated).toHaveBeenCalledTimes(1);
	});
});

describe("webhook endpoint", () => {
	it("answers 200 for ids it does not know, as Mollie recommends", async () => {
		const env = await setup();
		expect((await env.webhook("id=tr_doesnotexist")).status).toBe(200);
		expect((await env.webhook("id=sub_doesnotexist")).status).toBe(200);
	});

	it("rejects bodies without a Mollie resource id", async () => {
		const env = await setup();
		expect((await env.webhook("")).status).toBe(400);
		expect((await env.webhook("id=../../etc")).status).toBe(400);
		expect((await env.webhook("{nope", "application/json")).status).toBe(400);
	});

	it("accepts a JSON body with an id", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		const response = await env.webhook(JSON.stringify({ id: payment.id }), "application/json");
		expect(response.status).toBe(200);
		expect((await env.subscriptions())[0]?.status).toBe("active");
	});

	it("never trusts the body: only the status fetched from Mollie counts", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		const response = await env.webhook(`id=${payment.id}&status=paid&amount=0.01`);
		expect(response.status).toBe(200);
		expect((await env.subscriptions())[0]?.status).toBe("incomplete");
		expect(env.fake.callsTo("payments.get").length).toBeGreaterThan(0);
	});

	it("answers 500 when Mollie cannot be reached, so Mollie retries", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.failNext("payments.get", new TypeError("fetch failed"));
		expect((await env.webhook(`id=${payment.id}`)).status).toBe(500);
	});
});

describe("local development", () => {
	it("leaves out a webhook URL Mollie cannot reach, and still activates via the redirect", async () => {
		const env = await setup({ auth: { baseURL: "http://localhost:5173" } });
		const { payment } = await env.checkout("starter");
		expect(payment.webhookUrl ?? null).toBeNull();
		env.fake.completePayment(payment.id, "paid");
		const [row] = await env.subscriptions();
		const response = await env.auth.handler(
			new Request(
				`http://localhost:5173/api/auth/subscription/success?subscriptionId=${row!.id}&callbackURL=/dashboard`,
				{ headers: env.headers },
			),
		);
		expect(response.status).toBe(302);
		expect((await env.subscription(row!.id)).status).toBe("active");
		const [remote] = env.fake.activeSubscriptionsFor(payment.customerId!);
		expect(remote?.webhookUrl ?? null).toBeNull();
	});

	it("uses an explicit webhookUrl as given", async () => {
		const env = await setup({
			auth: { baseURL: "http://localhost:5173" },
			options: { webhookUrl: "https://abc123.ngrok.app/api/auth/mollie/webhook" },
		});
		const { payment } = await env.checkout("starter");
		expect(payment.webhookUrl).toBe("https://abc123.ngrok.app/api/auth/mollie/webhook");
	});
});
