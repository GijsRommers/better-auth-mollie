/**
 * The sync does what is needed and no more: no hopeless Mollie calls, no
 * refetching what cannot change, and no rows left behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { PLANS, setup, subscribe, travel } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

describe("efficient sync", () => {
	it("does not keep recreating a suspended Mollie subscription on an invalid mandate", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		env.fake.mandates.get(subscription.mollieMandateId!)!.status = "invalid";
		env.fake.setSubscriptionStatus(subscription.mollieSubscriptionId!, "suspended");
		const creates = env.fake.callsTo("subscriptions.create").length;

		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		for (let i = 0; i < 3; i++) {
			const result = await syncMollieSubscriptions(env.auth as never);
			expect(result.errors).toEqual([]);
			travel(Date.now() + 3_600_000);
		}
		expect(env.fake.callsTo("subscriptions.create")).toHaveLength(creates);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
	});

	it("does not reuse an open checkout in another currency", async () => {
		let currency = "EUR";
		const env = await setup({
			subscription: {
				plans: async () =>
					PLANS.map((plan) => (plan.name === "starter" ? { ...plan, currency } : plan)),
			},
		});
		const first = await env.checkout("starter");
		currency = "USD";
		const second = await env.checkout("starter");
		expect(second.payment.id).not.toBe(first.payment.id);
		expect(second.payment.amount.currency).toBe("USD");
	});
});
