/**
 * The sync does what is needed and no more: no hopeless Mollie calls, no
 * refetching what cannot change, and no rows left behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLANS, setup } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

describe("efficient sync", () => {
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
