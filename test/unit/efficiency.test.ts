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

		// Calls about this subscription (not the profile-wide chargeback list).
		const callsDuring = async (at: number) => {
			travel(at);
			const before = env.fake.calls.length;
			await syncMollieSubscriptions(env.auth as never);
			return env.fake.calls.slice(before).filter((c) => c.method !== "chargebacks.all").length;
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

	it("gives an old pending row a day from its latest checkout attempt", async () => {
		const env = await setup();
		env.fake.failNext("payments.create", Object.assign(new Error("invalid"), { statusCode: 422 }));
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers }),
		).rejects.toBeTruthy();
		const [row] = await env.subscriptions();
		travel(Date.now() + 25 * 3_600_000);

		// A retry whose response is lost: the payment may exist, unrecorded.
		env.fake.loseNextResponse("payments.create");
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers }),
		).rejects.toBeTruthy();
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(row!.id)).status).toBe("incomplete");

		travel(Date.now() + 25 * 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(row!.id)).status).toBe("incomplete_expired");
	});

	it("finds a recent checkout attempt behind a page of lookalike journal keys", async () => {
		const env = await setup();
		env.fake.failNext("payments.create", Object.assign(new Error("invalid"), { statusCode: 422 }));
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers }),
		).rejects.toBeTruthy();
		const [row] = await env.subscriptions();
		travel(Date.now() + 25 * 3_600_000);
		env.fake.loseNextResponse("payments.create");
		await expect(
			env.api.upgradeSubscription({ body: { plan: "starter" }, headers: env.headers }),
		).rejects.toBeTruthy();

		// SQL adapters implement starts_with as an unescaped LIKE: keys of other
		// rows can match too, and fill the first page.
		const adapter = env.context.adapter as any;
		const original = adapter.findMany.bind(adapter);
		adapter.findMany = async (args: any) => {
			const prefix = args.where?.find((w: any) => w.operator === "starts_with")?.value;
			const kind = args.where?.find((w: any) => w.field === "kind")?.value;
			if (
				args.model !== "mollieOperation" ||
				kind !== "create_first_payment" ||
				!prefix?.endsWith(":")
			) {
				return original(args);
			}
			const lookalikes = Array.from({ length: 100 }, (_, i) => ({
				idempotencyKey: `${prefix.slice(0, -1)}x:starter:9.95:EUR#${i}`,
				kind,
				status: "failed",
				createdAt: new Date(),
			}));
			const all = [...lookalikes, ...(await original({ ...args, limit: 1000, offset: 0 }))];
			const offset = args.offset ?? 0;
			return all.slice(offset, offset + (args.limit ?? all.length));
		};
		await syncMollieSubscriptions(env.auth as never);
		adapter.findMany = original;
		expect((await env.subscription(row!.id)).status).toBe("incomplete");
	});
});
