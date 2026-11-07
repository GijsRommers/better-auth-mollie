/**
 * Archived plans: how prices change. New customers get the new plan, while
 * subscriptions already on the archived one keep it, at its price.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import type { MolliePlan } from "../../src/types";
import { PLANS, setup, subscribe, travel } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

/** Plans whose `starter` can be archived during a test. */
function archivable() {
	let archived = false;
	return {
		plans: async (): Promise<MolliePlan[]> =>
			PLANS.map((plan) => (plan.name === "starter" ? { ...plan, archived } : plan)),
		archive: () => {
			archived = true;
		},
	};
}

describe("archived plans", () => {
	it("are not offered to new subscriptions", async () => {
		const { plans, archive } = archivable();
		const env = await setup({ subscription: { plans } });
		archive();
		await expect(env.checkout("starter")).rejects.toMatchObject({
			body: { code: "SUBSCRIPTION_PLAN_ARCHIVED" },
		});
		expect(env.fake.callsTo("payments.create")).toEqual([]);
	});

	it("still start from a checkout begun before archiving", async () => {
		const { plans, archive } = archivable();
		const env = await setup({ subscription: { plans } });
		const { payment } = await env.checkout("starter");
		archive();
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		const [subscription] = await env.subscriptions();
		expect(subscription).toMatchObject({ status: "active", plan: "starter" });
		expect(subscription?.mollieSubscriptionId).toBeTruthy();
	});

	it("keep billing the subscriptions already on them, at their price", async () => {
		const { plans, archive } = archivable();
		const env = await setup({ subscription: { plans } });
		const subscription = await subscribe(env);
		archive();

		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await env.webhook(`id=${renewal.id}`);
		const renewed = await env.subscription(subscription.id);
		expect(renewed).toMatchObject({ status: "active", plan: "starter" });
		expect(new Date(renewed.periodEnd!).getTime()).toBeGreaterThan(
			new Date(subscription.periodEnd!).getTime(),
		);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toEqual([
			expect.objectContaining({ id: subscription.mollieSubscriptionId, amount: renewal.amount }),
		]);
	});

	it("let their subscribers change to another plan", async () => {
		const { plans, archive } = archivable();
		const env = await setup({ subscription: { plans } });
		const subscription = await subscribe(env);
		archive();
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		expect((await env.subscription(subscription.id)).plan).toBe("business");
	});

	it("refuse plan changes to them", async () => {
		const { plans, archive } = archivable();
		const env = await setup({ subscription: { plans } });
		const subscription = await subscribe(env, "business");
		archive();
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers }),
		).rejects.toMatchObject({ body: { code: "SUBSCRIPTION_PLAN_ARCHIVED" } });
		expect((await env.subscription(subscription.id)).pendingPlan ?? null).toBeNull();
	});

	it("let their subscribers cancel, restore and recover", async () => {
		const { plans, archive } = archivable();
		const env = await setup({ subscription: { plans } });
		const subscription = await subscribe(env);
		archive();

		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		expect((await env.subscription(subscription.id)).cancelAtPeriodEnd).toBe(true);
		await env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers });
		expect((await env.subscription(subscription.id)).cancelAtPeriodEnd).toBe(false);

		// A failed renewal (of the Mollie subscription the restore created):
		// paying again restarts it on the archived plan.
		const restored = await env.subscription(subscription.id);
		travel(new Date(restored.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(restored.mollieSubscriptionId!, "failed");
		await env.webhook(`id=${failed.id}`);
		const { headers } = await env.signInWithTestUser();
		const result = await env.api.upgradeSubscription({ body: { plan: "starter" }, headers });
		expect(result).toMatchObject({ url: expect.stringContaining("checkout") });
		const recovery = [...env.fake.payments.values()].at(-1)!;
		expect(recovery).toMatchObject({ metadata: expect.objectContaining({ purpose: "recovery" }) });
	});

	it("are refused for a recovery onto another plan", async () => {
		const { plans, archive } = archivable();
		const env = await setup({ subscription: { plans } });
		const subscription = await subscribe(env, "business");
		archive();
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
		await env.webhook(`id=${failed.id}`);
		const { headers } = await env.signInWithTestUser();
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers }),
		).rejects.toMatchObject({ body: { code: "SUBSCRIPTION_PLAN_ARCHIVED" } });
	});

	it("report a subscription whose plan was removed from the configuration", async () => {
		let current = PLANS;
		const env = await setup({ subscription: { plans: async () => current } });
		const subscription = await subscribe(env);
		current = PLANS.filter((plan) => plan.name !== "starter");
		// The day before the next charge, when the sync looks at Mollie.
		travel(new Date(subscription.periodEnd!).getTime() - 12 * 3_600_000);
		const result = await syncMollieSubscriptions(env.auth as never);
		expect(result.errors).toEqual([
			expect.objectContaining({
				subscriptionId: subscription.id,
				message: expect.stringContaining('Plan "starter"'),
			}),
		]);
		expect(env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!)).toHaveLength(1);
	});

	describe("a subscription whose plan was removed", () => {
		async function onRemovedPlan() {
			let current = PLANS;
			const env = await setup({ subscription: { plans: async () => current } });
			const subscription = await subscribe(env);
			const remove = () => {
				current = PLANS.filter((plan) => plan.name !== "starter");
			};
			return { env, subscription, remove };
		}
		const reportsPlan = (result: { errors: { message: string }[] }) =>
			expect(result.errors.map((e) => e.message)).toEqual([
				expect.stringContaining('Plan "starter"'),
			]);

		it("still becomes unpaid when its grace period ends", async () => {
			const { env, subscription, remove } = await onRemovedPlan();
			travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
			const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
			await env.webhook(`id=${failed.id}`);
			remove();
			travel(new Date(subscription.periodEnd!).getTime() + 15 * 24 * 3_600_000);
			reportsPlan(await syncMollieSubscriptions(env.auth as never));
			expect((await env.subscription(subscription.id)).status).toBe("unpaid");
		});

		it("still counts as delinquent when no renewal arrives", async () => {
			const { env, subscription, remove } = await onRemovedPlan();
			remove();
			travel(new Date(subscription.periodEnd!).getTime() + 15 * 24 * 3_600_000);
			reportsPlan(await syncMollieSubscriptions(env.auth as never));
			expect((await env.subscription(subscription.id)).status).not.toBe("active");
		});

		it("is reported while unpaid", async () => {
			const { env, subscription, remove } = await onRemovedPlan();
			travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
			const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
			await env.webhook(`id=${failed.id}`);
			travel(new Date(subscription.periodEnd!).getTime() + 15 * 24 * 3_600_000);
			await syncMollieSubscriptions(env.auth as never);
			expect((await env.subscription(subscription.id)).status).toBe("unpaid");
			remove();
			travel(Date.now() + 25 * 3_600_000);
			reportsPlan(await syncMollieSubscriptions(env.auth as never));
		});
	});
});
