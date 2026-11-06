import { afterEach, describe, expect, it, vi } from "vitest";
import { hasActiveSubscription, syncMollieSubscriptions } from "../../src";
import { prorationCents } from "../../src/routes/subscription";
import type { Subscription } from "../../src/types";
import { settle, setup, type TestEnv } from "../helpers/setup";

const DAY = 86_400_000;

afterEach(() => {
	vi.useRealTimers();
});

/** Moves the clock (Date only; timers and I/O keep running). */
function travel(to: Date | number) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(to);
}

async function subscribe(env: TestEnv, plan = "starter") {
	const { payment } = await env.checkout(plan);
	env.fake.completePayment(payment.id, "paid");
	await env.webhook(`id=${payment.id}`);
	const [subscription] = await env.subscriptions();
	const mollieSubscription = env.fake.subscriptions.get(subscription!.mollieSubscriptionId!)!;
	return { subscription: subscription!, mollieSubscription, payment };
}

/** Lets Mollie charge the subscription at its next payment date. */
async function renew(env: TestEnv, subscription: Subscription, status: "paid" | "failed" = "paid") {
	const mollieId = (await env.subscription(subscription.id)).mollieSubscriptionId!;
	const payment = env.fake.chargeSubscription(mollieId, status);
	await env.webhook(`id=${payment.id}`);
	return payment;
}

describe("renewals", () => {
	it("advances the period to Mollie's next payment date on a paid renewal", async () => {
		const env = await setup();
		const { subscription, mollieSubscription } = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		await renew(env, subscription);

		const renewed = await env.subscription(subscription.id);
		expect(renewed.status).toBe("active");
		expect(renewed.periodStart).toEqual(subscription.periodEnd);
		expect(renewed.periodEnd!.toISOString().slice(0, 10)).toBe(
			env.fake.subscriptions.get(mollieSubscription.id)!.nextPaymentDate,
		);
		await settle();
		expect(env.hooks.onPaymentPaid).toHaveBeenCalledTimes(2);
		expect(env.hooks.onPaymentPaid.mock.calls[1]![0]).toMatchObject({ purpose: "renewal" });
	});

	it("moves a trial to active on the first charge", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env, "pro");
		expect(subscription.status).toBe("trialing");
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		await renew(env, subscription);
		expect((await env.subscription(subscription.id)).status).toBe("active");
	});

	it("goes past_due on a failed renewal, keeps access through the grace period, then unpaid", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!).getTime();
		travel(periodEnd + 3_600_000);
		await renew(env, subscription, "failed");

		expect((await env.subscription(subscription.id)).status).toBe("past_due");
		await settle();
		expect(env.hooks.onPaymentFailed).toHaveBeenCalledTimes(1);
		expect(await hasActiveSubscription(env.auth as never, env.user.id)).toBe(true);

		travel(periodEnd + 15 * DAY);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("unpaid");
		expect(await hasActiveSubscription(env.auth as never, env.user.id)).toBe(false);
	});

	it("recovers to active when a later charge succeeds", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		await renew(env, subscription, "failed");
		travel(new Date(subscription.periodEnd!).getTime() + 2 * DAY);
		await renew(env, subscription, "paid");
		expect((await env.subscription(subscription.id)).status).toBe("active");
	});

	it("ignores a late failure for a period that a later payment already paid", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		const mollieId = subscription.mollieSubscriptionId!;
		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		const early = env.fake.chargeSubscription(mollieId, "open");
		travel(new Date(subscription.periodEnd!).getTime() + 31 * DAY);
		await renew(env, subscription, "paid");
		env.fake.completePayment(early.id, "failed");
		await env.webhook(`id=${early.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");
	});
});

describe("Mollie subscription status", () => {
	it("maps suspended to past_due", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		env.fake.setSubscriptionStatus(subscription.mollieSubscriptionId!, "suspended");
		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
	});

	it("ends a paid-up subscription at period end when Mollie cancels it", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		env.fake.setSubscriptionStatus(subscription.mollieSubscriptionId!, "canceled");
		await env.webhook(`id=${subscription.mollieSubscriptionId}`);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "active",
			cancelAtPeriodEnd: true,
		});
	});

	it("cancels a delinquent subscription right away when Mollie cancels it", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		await renew(env, subscription, "failed");
		env.fake.setSubscriptionStatus(subscription.mollieSubscriptionId!, "canceled");
		await env.webhook(`id=${subscription.mollieSubscriptionId}`);
		expect((await env.subscription(subscription.id)).status).toBe("canceled");
		await settle();
		expect(env.hooks.onSubscriptionCanceled).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "mollie_canceled" }),
			expect.anything(),
		);
	});
});

describe("cancel and restore", () => {
	it("stops Mollie billing now and ends access at period end", async () => {
		const env = await setup();
		const { subscription, mollieSubscription } = await subscribe(env);
		const result = await env.api.cancelSubscription({
			body: { returnUrl: "/account" },
			headers: env.headers,
		});
		expect(result).toEqual({ url: "http://localhost:3000/account", redirect: true });
		expect(env.fake.subscriptions.get(mollieSubscription.id)?.status).toBe("canceled");
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "active",
			cancelAtPeriodEnd: true,
		});
		expect(await hasActiveSubscription(env.auth as never, env.user.id)).toBe(true);

		travel(new Date(subscription.periodEnd!).getTime() + 1000);
		expect(await hasActiveSubscription(env.auth as never, env.user.id)).toBe(false);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("canceled");
		await settle();
		expect(env.hooks.onSubscriptionCanceled).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "period_ended" }),
			expect.anything(),
		);
	});

	it("restores a pending cancellation with a new Mollie subscription from period end", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		const restored = await env.api.restoreSubscription({ body: {}, headers: env.headers });

		expect(restored).toMatchObject({ cancelAtPeriodEnd: false, limits: { projects: 3 } });
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active).toHaveLength(1);
		expect(active[0]!.id).toBe(restored.mollieSubscriptionId);
		expect(active[0]!.startDate).toBe(new Date(subscription.periodEnd!).toISOString().slice(0, 10));
	});

	it("refuses to restore when nothing is pending", async () => {
		const env = await setup();
		await subscribe(env);
		await expect(
			env.api.restoreSubscription({ body: {}, headers: env.headers }),
		).rejects.toMatchObject({ body: { code: "SUBSCRIPTION_NOT_PENDING_CHANGE" } });
	});
});

describe("plan changes", () => {
	it("upgrades right away and charges only the pro-rata difference", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env, "starter");
		const start = new Date(subscription.periodStart!).getTime();
		const end = new Date(subscription.periodEnd!).getTime();
		travel(start + (end - start) / 2);
		// Sessions last 7 days; sign in again after jumping ahead.
		const { headers } = await env.signInWithTestUser();

		await env.api.upgradeSubscription({
			body: { plan: "business", returnUrl: "/billing" },
			headers,
		});
		const upgraded = await env.subscription(subscription.id);
		expect(upgraded).toMatchObject({ plan: "business", pendingPlan: null, status: "active" });

		const proration = [...env.fake.payments.values()].find(
			(p) => (p.metadata as { purpose?: string }).purpose === "proration",
		)!;
		// Half of (49.00 - 9.95) = 19.53 (rounded half up from 19.525).
		expect(proration).toMatchObject({
			sequenceType: "recurring",
			amount: { value: "19.53" },
			mandateId: subscription.mollieMandateId,
		});
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			amount: { value: "49.00" },
			startDate: new Date(end).toISOString().slice(0, 10),
		});
	});

	it("computes pro-rata differences from the remaining part of the period", () => {
		const sub = {
			periodStart: new Date("2026-01-01T00:00:00Z"),
			periodEnd: new Date("2026-01-31T00:00:00Z"),
		} as Subscription;
		const starter = { name: "s", amount: "10.00", interval: "1 month" as const };
		const business = { name: "b", amount: "40.00", interval: "1 month" as const };
		expect(prorationCents(sub, starter, business, new Date("2026-01-01T00:00:00Z"))).toBe(3000);
		expect(prorationCents(sub, starter, business, new Date("2026-01-21T00:00:00Z"))).toBe(1000);
		expect(prorationCents(sub, starter, business, new Date("2026-01-31T00:00:00Z"))).toBe(0);
		expect(prorationCents(sub, business, starter, new Date("2026-01-11T00:00:00Z"))).toBe(0);
	});

	it("marks the subscription past_due when the pro-rata charge fails", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env, "starter");
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		const proration = [...env.fake.payments.values()].at(-1)!;
		env.fake.completePayment(proration.id, "failed");
		await env.webhook(`id=${proration.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
		await settle();
		expect(env.hooks.onPaymentFailed.mock.calls[0]![0]).toMatchObject({ purpose: "proration" });
	});

	it("schedules a downgrade for the next period", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env, "business");
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });

		expect(await env.subscription(subscription.id)).toMatchObject({
			plan: "business",
			pendingPlan: "starter",
		});
		expect([...env.fake.payments.values()]).toHaveLength(1); // nothing charged now
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({
			amount: { value: "9.95" },
			startDate: new Date(subscription.periodEnd!).toISOString().slice(0, 10),
			metadata: { plan: "starter" },
		});
		const [listed] = await env.api.listActiveSubscriptions({ headers: env.headers });
		expect(listed).toMatchObject({ plan: "business", pendingPlan: "starter" });

		// At period end the cheaper plan takes over.
		travel(new Date(subscription.periodEnd!).getTime() + 1000);
		await renew(env, subscription);
		expect(await env.subscription(subscription.id)).toMatchObject({
			plan: "starter",
			pendingPlan: null,
		});
	});

	it("switches to the scheduled plan at period end even before the new plan is charged", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env, "business");
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		travel(new Date(subscription.periodEnd!).getTime() + 1000);
		await syncMollieSubscriptions(env.auth as never);
		expect(await env.subscription(subscription.id)).toMatchObject({
			plan: "starter",
			pendingPlan: null,
		});
	});

	it("drops a scheduled downgrade when the current plan is chosen again", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env, "business");
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		expect(await env.subscription(subscription.id)).toMatchObject({
			plan: "business",
			pendingPlan: null,
		});
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active).toHaveLength(1);
		expect(active[0]!.amount.value).toBe("49.00");
		expect([...env.fake.payments.values()]).toHaveLength(1);
	});

	it("schedules a change to another interval for the next period", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env, "starter");
		await env.api.upgradeSubscription({ body: { plan: "yearly" }, headers: env.headers });
		expect(await env.subscription(subscription.id)).toMatchObject({
			plan: "starter",
			pendingPlan: "yearly",
		});
		expect([...env.fake.payments.values()]).toHaveLength(1);
	});

	it("changes plan right away and free of charge during a trial", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env, "pro");
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		expect(await env.subscription(subscription.id)).toMatchObject({
			plan: "business",
			status: "trialing",
			pendingPlan: null,
		});
		expect([...env.fake.payments.values()]).toHaveLength(1);
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active[0]).toMatchObject({
			amount: { value: "49.00" },
			startDate: new Date(subscription.trialEnd!).toISOString().slice(0, 10),
		});
	});

	it("rejects choosing the current plan again", async () => {
		const env = await setup();
		await subscribe(env, "starter");
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers }),
		).rejects.toMatchObject({ body: { code: "ALREADY_SUBSCRIBED_PLAN" } });
	});
});

describe("recovering a past-due subscription", () => {
	it("restarts the subscription on a new mandate after a recovery checkout", async () => {
		const env = await setup();
		const { subscription, mollieSubscription } = await subscribe(env, "starter");
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		await renew(env, subscription, "failed");
		expect((await env.subscription(subscription.id)).status).toBe("past_due");

		const { headers } = await env.signInWithTestUser();
		await env.api.upgradeSubscription({
			body: { plan: "starter", successUrl: "/dashboard" },
			headers,
		});
		const payment = [...env.fake.payments.values()].at(-1)!;
		const result = { url: payment.links.checkout?.href };
		expect(result.url).toBe(payment.links.checkout?.href);
		expect(payment).toMatchObject({
			sequenceType: "first",
			amount: { value: "9.95" },
			metadata: { purpose: "recovery" },
		});
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);

		const recovered = await env.subscription(subscription.id);
		expect(recovered).toMatchObject({ status: "active", plan: "starter" });
		expect(recovered.mollieMandateId).toBe(env.fake.payments.get(payment.id)!.mandateId);
		expect(env.fake.subscriptions.get(mollieSubscription.id)?.status).toBe("canceled");
		const active = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(active).toHaveLength(1);
		expect(active[0]!.mandateId).toBe(recovered.mollieMandateId);
		expect(new Date(recovered.periodStart!).getTime()).toBeGreaterThan(
			new Date(subscription.periodEnd!).getTime(),
		);
	});
});

describe("syncMollieSubscriptions", () => {
	it("only asks Mollie about stable subscriptions around their next payment date", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		const calls = () => env.fake.callsTo("subscriptions.get").length;

		const before = calls();
		const quiet = await syncMollieSubscriptions(env.auth as never);
		expect(quiet).toMatchObject({ checked: 1, remoteChecked: 0, errors: [] });
		expect(calls()).toBe(before);

		travel(new Date(subscription.periodEnd!).getTime() - 3_600_000);
		const due = await syncMollieSubscriptions(env.auth as never);
		expect(due.remoteChecked).toBe(1);
		expect(calls()).toBe(before + 1);
	});

	it("picks up a renewal whose webhook never arrived", async () => {
		const env = await setup();
		const { subscription } = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await syncMollieSubscriptions(env.auth as never);
		const synced = await env.subscription(subscription.id);
		expect(new Date(synced.periodEnd!).getTime()).toBeGreaterThan(
			new Date(subscription.periodEnd!).getTime(),
		);
	});

	it("activates a checkout whose webhook and redirect never arrived", async () => {
		const env = await setup();
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscriptions())[0]?.status).toBe("active");
	});
});
