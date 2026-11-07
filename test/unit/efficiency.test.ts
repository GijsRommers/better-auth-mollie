/**
 * The sync does what is needed and no more: no hopeless Mollie calls, no
 * refetching what cannot change, and no rows left behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { addDays } from "../../src/utils";
import { PLANS, settle, setup, subscribe, travel } from "../helpers/setup";

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

	it("checks an unpaid subscription at Mollie once a day, not on every sync", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
		await env.webhook(`id=${failed.id}`);
		travel(addDays(periodEnd, 15));
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("unpaid");

		const callsDuring = async (at: number) => {
			travel(at);
			const before = env.fake.calls.length;
			await syncMollieSubscriptions(env.auth as never);
			return env.fake.calls.length - before;
		};
		const checked = Date.now();
		expect(await callsDuring(checked + 3_600_000)).toBe(0);
		expect(await callsDuring(checked + 23 * 3_600_000)).toBe(0);
		expect(await callsDuring(checked + 24 * 3_600_000)).toBeGreaterThan(0);
		expect(await callsDuring(checked + 25 * 3_600_000)).toBe(0);
	});

	it("still picks up a paid charge of an unpaid subscription whose webhook was lost", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const periodEnd = new Date(subscription.periodEnd!);
		travel(periodEnd.getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
		await env.webhook(`id=${failed.id}`);
		travel(addDays(periodEnd, 15));
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("unpaid");

		const next = new Date(periodEnd);
		next.setUTCMonth(next.getUTCMonth() + 1);
		travel(next.getTime() + 3_600_000);
		env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		travel(Date.now() + 24 * 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("active");
	});

	it("does not refetch payments it decided not to invoice", async () => {
		const getRecipient = vi.fn(async () => null);
		const env = await setup({
			subscription: { tax: { calculate: () => ({ rate: "21.00", country: "NL" }) } },
			options: { salesInvoices: { enabled: true, getRecipient } },
		});
		await subscribe(env);
		await settle();
		await syncMollieSubscriptions(env.auth as never);
		const asked = getRecipient.mock.calls.length;
		const fetches = env.fake.callsTo("payments.get").length;
		await syncMollieSubscriptions(env.auth as never);
		expect(getRecipient.mock.calls.length).toBe(asked);
		expect(env.fake.callsTo("payments.get")).toHaveLength(fetches);
		expect(env.fake.salesInvoices.size).toBe(0);
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

	it("expires a pending row whose checkout was never created, after a day", async () => {
		const env = await setup();
		env.fake.failNext("payments.create", Object.assign(new Error("invalid"), { statusCode: 422 }));
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers }),
		).rejects.toBeTruthy();
		const [row] = await env.subscriptions();
		expect(row?.status).toBe("incomplete");

		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(row!.id)).status).toBe("incomplete");
		travel(Date.now() + 25 * 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(row!.id)).status).toBe("incomplete_expired");
	});
});
