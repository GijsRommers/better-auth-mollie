/**
 * `refundVerificationPayment`: a trial's verification payment is refunded
 * once it created the mandate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { setup } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

/** A paid trial checkout ("pro" has a free trial), processed by its webhook. */
async function startTrial(env: Awaited<ReturnType<typeof setup>>) {
	const { payment } = await env.checkout("pro");
	env.fake.completePayment(payment.id, "paid");
	await env.webhook(`id=${payment.id}`);
	const [subscription] = await env.subscriptions();
	return { payment, subscription: subscription! };
}

const record = async (env: Awaited<ReturnType<typeof setup>>, id: string) =>
	(await env.payments()).find((r) => r.molliePaymentId === id)!;

describe("refundVerificationPayment", () => {
	it("refunds the verification payment once the trial started", async () => {
		const env = await setup({ subscription: { refundVerificationPayment: true } });
		const { payment, subscription } = await startTrial(env);
		expect(subscription.status).toBe("trialing");
		expect(env.fake.callsTo("refunds.create")).toHaveLength(1);
		const [refund] = [...env.fake.refunds.values()];
		expect(refund).toMatchObject({
			paymentId: payment.id,
			amount: { currency: "EUR", value: payment.amount.value },
		});
		expect((await record(env, payment.id)).refundDue).toBe(false);

		// Delivered again, or synced: no second refund.
		await env.webhook(`id=${payment.id}`);
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.callsTo("refunds.create")).toHaveLength(1);
	});

	it("retries a refund that failed, from the sync", async () => {
		const env = await setup({ subscription: { refundVerificationPayment: true } });
		env.fake.failNext("refunds.create", new TypeError("fetch failed"));
		const { payment, subscription } = await startTrial(env);
		expect(subscription.status).toBe("trialing");
		expect((await record(env, payment.id)).refundDue).toBe(true);

		const result = await syncMollieSubscriptions(env.auth as never);
		expect(result.errors).toEqual([]);
		expect(env.fake.refunds.size).toBe(1);
		expect((await record(env, payment.id)).refundDue).toBe(false);
	});

	it("does not refund by default", async () => {
		const env = await setup();
		await startTrial(env);
		expect(env.fake.callsTo("refunds.create")).toEqual([]);
	});

	it("has nothing to refund for a verification of 0.00", async () => {
		const env = await setup({
			subscription: { refundVerificationPayment: true, verificationAmount: "0.00" },
		});
		const { payment } = await startTrial(env);
		expect(env.fake.callsTo("refunds.create")).toEqual([]);
		expect((await record(env, payment.id)).refundDue ?? false).toBe(false);
	});

	it("does not refund a checkout that is not a verification", async () => {
		const env = await setup({ subscription: { refundVerificationPayment: true } });
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		expect(env.fake.callsTo("refunds.create")).toEqual([]);
	});
});
