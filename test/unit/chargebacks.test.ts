/**
 * Chargebacks: a disputed card payment or a reversed SEPA Direct Debit takes
 * money back after a payment was paid (and applied).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasActiveSubscription, syncMollieSubscriptions } from "../../src";
import { settleCustomerCharges } from "../../src/billing";
import type { Subscription } from "../../src/types";
import { addDays } from "../../src/utils";
import { settle, setup, subscribe, type TestEnv, travel } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

async function withChargebackHook() {
	const onChargeback = vi.fn(async (..._args: any[]) => {});
	const env = await setup({ subscription: { onChargeback } });
	return { env, onChargeback };
}

/** Mollie charges the subscription at its period end, paid, webhook processed. */
async function renew(env: TestEnv, subscription: Subscription) {
	travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
	const payment = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
	await env.webhook(`id=${payment.id}`);
	return { payment, renewed: await env.subscription(subscription.id) };
}

describe("chargebacks", () => {
	it("makes the subscription past due from the start of the period that was charged back", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const { payment, renewed } = await renew(env, subscription);
		expect(renewed.status).toBe("active");

		env.fake.chargeBack(payment.id);
		await env.webhook(`id=${payment.id}`);
		const chargedBack = await env.subscription(subscription.id);
		expect(chargedBack).toMatchObject({ status: "past_due" });
		expect(new Date(chargedBack.periodEnd!)).toEqual(new Date(renewed.periodStart!));
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(1);
		expect(onChargeback.mock.calls[0]![0]).toMatchObject({
			purpose: "renewal",
			payment: { id: payment.id },
			subscription: { id: subscription.id, status: "past_due" },
			chargeback: { amount: { currency: "EUR", value: "9.95" }, reversed: false },
		});

		// Delivered again: nothing changes, the hook does not run again.
		await env.webhook(`id=${payment.id}`);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(1);

		// The grace period counts from the start of the unpaid period.
		travel(addDays(new Date(renewed.periodStart!), 13));
		expect(await hasActiveSubscription(env.auth as never, subscription.referenceId)).toBe(true);
		travel(addDays(new Date(renewed.periodStart!), 15));
		expect(await hasActiveSubscription(env.auth as never, subscription.referenceId)).toBe(false);
		await syncMollieSubscriptions(env.auth as never);
		expect((await env.subscription(subscription.id)).status).toBe("unpaid");
	});

	it("does the same for a charged-back first payment during its period", async () => {
		const { env } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		const chargedBack = await env.subscription(subscription.id);
		expect(chargedBack.status).toBe("past_due");
		expect(new Date(chargedBack.periodEnd!)).toEqual(new Date(subscription.periodStart!));
	});

	it("only reports a chargeback of an earlier period's payment", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		const { renewed } = await renew(env, subscription);

		env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "active",
			periodEnd: renewed.periodEnd,
		});
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(1);
		expect(onChargeback.mock.calls[0]![0]).toMatchObject({ purpose: "checkout" });
	});

	it("judges a charged-back pro-rata charge like a failed one", async () => {
		const { env } = await withChargebackHook();
		const subscription = await subscribe(env);
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		const proration = [...env.fake.payments.values()].at(-1)!;
		env.fake.completePayment(proration.id, "paid");
		await env.webhook(`id=${proration.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("active");

		env.fake.chargeBack(proration.id);
		await env.webhook(`id=${proration.id}`);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "past_due",
			periodEnd: subscription.periodEnd,
		});
	});

	it("picks up a chargeback whose webhook never arrived, from the sync", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const { payment } = await renew(env, subscription);
		env.fake.chargeBack(payment.id);

		const result = await syncMollieSubscriptions(env.auth as never);
		expect(result.errors).toEqual([]);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
		await syncMollieSubscriptions(env.auth as never);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(1);
	});

	it("reports a reversal, and leaves recovering to the customer", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const { payment } = await renew(env, subscription);
		const chargeback = env.fake.chargeBack(payment.id);
		await env.webhook(`id=${payment.id}`);

		env.fake.reverseChargeback(chargeback.id);
		await env.webhook(`id=${payment.id}`);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(2);
		expect(onChargeback.mock.calls[1]![0]).toMatchObject({
			chargeback: { amount: { value: "0.00" }, reversed: true },
		});
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
		const [record] = (await env.payments()).filter((r) => r.molliePaymentId === payment.id);
		expect(record?.amountChargedBack ?? null).toBeNull();
	});

	it("judges a charged-back earlier upgrade in the same period like a failed one", async () => {
		const { env } = await withChargebackHook();
		const subscription = await subscribe(env);
		const upgrade = async (plan: string) => {
			await env.api.upgradeSubscription({ body: { plan }, headers: env.headers });
			const proration = [...env.fake.payments.values()].at(-1)!;
			env.fake.completePayment(proration.id, "paid");
			await env.webhook(`id=${proration.id}`);
			return proration;
		};
		const first = await upgrade("pro");
		await upgrade("business");
		expect((await env.subscription(subscription.id)).status).toBe("active");

		env.fake.chargeBack(first.id);
		await env.webhook(`id=${first.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");
	});

	it("knows what a payment paid for when the delivery that applied it stopped early", async () => {
		const { env } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		// The activation was stored, but not the payment's outcome.
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: first!.id }],
			update: { outcome: "pending", paidThrough: null },
		});
		await env.api.upgradeSubscription({ body: { plan: "business" }, headers: env.headers });
		const proration = [...env.fake.payments.values()].at(-1)!;
		env.fake.completePayment(proration.id, "paid");
		await env.webhook(`id=${proration.id}`);

		env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		const chargedBack = await env.subscription(subscription.id);
		expect(chargedBack.status).toBe("past_due");
		expect(new Date(chargedBack.periodEnd!)).toEqual(new Date(subscription.periodStart!));
	});

	it("picks up a second partial chargeback of the same amount, from the sync", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const { payment } = await renew(env, subscription);
		env.fake.chargeBack(payment.id, "4.00");
		await env.webhook(`id=${payment.id}`);
		travel(Date.now() + 20 * 24 * 3_600_000);
		env.fake.chargeBack(payment.id, "4.00");

		await syncMollieSubscriptions(env.auth as never);
		const [record] = (await env.payments()).filter((r) => r.molliePaymentId === payment.id);
		expect(record?.amountChargedBack).toBe("8.00");
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(2);
		expect(onChargeback.mock.calls[1]![0]).toMatchObject({
			chargeback: { amount: { value: "8.00" } },
		});
	});

	it("picks up the reversal of an older chargeback, from the sync", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		await renew(env, subscription);
		// An earlier period's payment: the subscription stays active, and the
		// sync has no reason to look at its payments.
		const chargeback = env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		travel(Date.now() + 20 * 24 * 3_600_000);
		env.fake.reverseChargeback(chargeback.id);

		await syncMollieSubscriptions(env.auth as never);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(2);
		expect(onChargeback.mock.calls[1]![0]).toMatchObject({ chargeback: { reversed: true } });
		expect((await env.subscription(subscription.id)).status).toBe("active");
	});

	it("still sees a reversal long after the chargeback, checking once a day", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		await renew(env, subscription);
		const chargeback = env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		travel(Date.now() + 130 * 24 * 3_600_000);
		env.fake.reverseChargeback(chargeback.id);

		await syncMollieSubscriptions(env.auth as never);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(2);
		expect(onChargeback.mock.calls[1]![0]).toMatchObject({ chargeback: { reversed: true } });
	});

	it("looks at a recorded chargeback once a day, not on every sync", async () => {
		const { env } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		await renew(env, subscription);
		env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		const listings = () => env.fake.callsTo("chargebacks.list").length;

		travel(Date.now() + 30 * 24 * 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		const checked = listings();
		travel(Date.now() + 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(listings()).toBe(checked);
		travel(Date.now() + 24 * 3_600_000);
		await syncMollieSubscriptions(env.auth as never);
		expect(listings()).toBeGreaterThan(checked);
	});

	it("does not keep reprocessing a payment when Mollie's total counts reversed chargebacks", async () => {
		const { env, onChargeback } = await withChargebackHook();
		env.fake.reportReversedChargebacks();
		const subscription = await subscribe(env);
		const { payment } = await renew(env, subscription);
		const one = env.fake.chargeBack(payment.id, "4.00");
		await env.webhook(`id=${payment.id}`);
		env.fake.chargeBack(payment.id, "4.00");
		await env.webhook(`id=${payment.id}`);
		env.fake.reverseChargeback(one.id);
		await env.webhook(`id=${payment.id}`);
		const record = async () =>
			(await env.payments()).find((r) => r.molliePaymentId === payment.id)!;
		expect((await record()).amountChargedBack).toBe("4.00");
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(3);

		// The past-due subscription is checked at Mollie on every sync, which
		// lists this payment with Mollie's (gross) total of 8.00.
		const claimed = (await record()).claimSerial;
		await syncMollieSubscriptions(env.auth as never);
		await syncMollieSubscriptions(env.auth as never);
		expect((await record()).claimSerial).toBe(claimed);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(3);
	});

	it("rechecks a chargeback recorded without a check time", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		await renew(env, subscription);
		const chargeback = env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		// As recorded before the column existed.
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: first!.id }],
			update: { chargebackCheckedAt: null },
		});
		travel(Date.now() + 130 * 24 * 3_600_000);
		env.fake.reverseChargeback(chargeback.id);

		await syncMollieSubscriptions(env.auth as never);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(2);
	});

	it("stops checking a chargeback whose reversal arrived while the sync looked at it", async () => {
		const { env } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		await renew(env, subscription);
		const chargeback = env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		// Only the daily check still looks at it.
		travel(Date.now() + 130 * 24 * 3_600_000);
		const listings = () => env.fake.callsTo("chargebacks.list").length;
		const before = listings();
		const release = env.fake.hold("chargebacks.list", "processing");
		const sync = syncMollieSubscriptions(env.auth as never);
		await vi.waitFor(() => expect(listings()).toBe(before + 1));
		env.fake.reverseChargeback(chargeback.id);
		await env.webhook(`id=${first!.id}`);
		release();
		await sync;

		const record = (await env.payments()).find((r) => r.molliePaymentId === first!.id)!;
		expect(record.amountChargedBack ?? null).toBeNull();
		expect(record.chargebackCheckedAt ?? null).toBeNull();
		travel(Date.now() + 25 * 3_600_000);
		const settled = listings();
		await syncMollieSubscriptions(env.auth as never);
		expect(listings()).toBe(settled);
	});

	it("keeps settling a customer's other charges when looking at one fails", async () => {
		const { env } = await withChargebackHook();
		env.fake.reportReversedChargebacks();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		const { payment } = await renew(env, subscription);
		const one = env.fake.chargeBack(payment.id, "4.00");
		await env.webhook(`id=${payment.id}`);
		env.fake.chargeBack(payment.id, "4.00");
		await env.webhook(`id=${payment.id}`);
		env.fake.reverseChargeback(one.id);
		await env.webhook(`id=${payment.id}`);
		// The first payment's hooks are still due (its delivery stopped).
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: first!.id }],
			update: { hooksDue: true },
		});

		// Confirming the renewal's chargeback (listed first, newest) fails.
		env.fake.failNext("chargebacks.list", new TypeError("fetch failed"));
		const options = (env.auth.options.plugins as any[]).find((p) => p.id === "mollie").options;
		const settlement = await settleCustomerCharges(
			{ context: env.context } as never,
			options,
			await env.subscription(subscription.id),
			new Date(),
		);
		expect(settlement.errors).toHaveLength(1);
		const record = (await env.payments()).find((r) => r.molliePaymentId === first!.id)!;
		expect(record.hooksDue).toBe(false);
	});

	it("keeps the grace period of a failed renewal when the period before is charged back", async () => {
		const { env, onChargeback } = await withChargebackHook();
		const subscription = await subscribe(env);
		const [first] = [...env.fake.payments.values()];
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
		await env.webhook(`id=${failed.id}`);
		expect((await env.subscription(subscription.id)).status).toBe("past_due");

		env.fake.chargeBack(first!.id);
		await env.webhook(`id=${first!.id}`);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "past_due",
			periodEnd: subscription.periodEnd,
		});
		expect(await hasActiveSubscription(env.auth as never, subscription.referenceId)).toBe(true);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(1);
	});

	it("does not try to refund a duplicate that was charged back", async () => {
		const onDuplicatePayment = vi.fn(async () => {});
		const env = await setup({ subscription: { onDuplicatePayment } });
		const first = await env.checkout("starter");
		const second = await env.checkout("business");
		env.fake.completePayment(first.payment.id, "paid");
		env.fake.completePayment(second.payment.id, "paid");
		await env.webhook(`id=${first.payment.id}`);
		env.fake.chargeBack(second.payment.id);
		const payment = env.fake.payments.get(second.payment.id)!;
		(payment as { amountRemaining?: unknown }).amountRemaining = { currency: "EUR", value: "0.00" };

		await env.webhook(`id=${second.payment.id}`);
		expect(env.fake.callsTo("refunds.create")).toEqual([]);
		const records = await env.payments();
		expect(records.find((r) => r.molliePaymentId === second.payment.id)?.outcome).toBe("refunded");
		await settle();
		expect(onDuplicatePayment).toHaveBeenCalledTimes(1);
	});
});
