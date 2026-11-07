/**
 * Chargebacks: a disputed card payment or a reversed SEPA Direct Debit takes
 * money back after a payment was paid (and applied).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasActiveSubscription, syncMollieSubscriptions } from "../../src";
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
