/**
 * `refundVerificationPayment`: a trial's verification payment is refunded
 * once it created the mandate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import { settle, setup, travel } from "../helpers/setup";

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

	it("refunds what is left after part was refunded by hand", async () => {
		const env = await setup({ subscription: { refundVerificationPayment: true } });
		env.fake.failNext("refunds.create", new TypeError("fetch failed"));
		const { payment } = await startTrial(env);
		await env.fake.client.refunds.create({
			paymentId: payment.id,
			refundRequest: { amount: { currency: "EUR", value: "0.01" }, description: "By hand" },
		} as never);

		const result = await syncMollieSubscriptions(env.auth as never);
		expect(result.errors).toEqual([]);
		const amounts = [...env.fake.refunds.values()].map((refund) => refund.amount.value);
		expect(amounts.sort()).toEqual(["0.01", "0.01"]);
		expect((await record(env, payment.id)).refundDue).toBe(false);
	});

	it("still refunds when a renewal settles a verification whose outcome was not recorded", async () => {
		const env = await setup({ subscription: { refundVerificationPayment: true } });
		env.fake.failNext("refunds.create", new TypeError("fetch failed"));
		const { payment, subscription } = await startTrial(env);
		// The activation was stored, but the delivery stopped before recording
		// the payment's outcome (and so its refund).
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: payment.id }],
			update: { outcome: "pending", refundDue: false },
		});
		travel(new Date(subscription.trialEnd!).getTime() + 3_600_000);
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await env.webhook(`id=${renewal.id}`);
		expect(await record(env, payment.id)).toMatchObject({ outcome: "applied", refundDue: true });

		await syncMollieSubscriptions(env.auth as never);
		expect([...env.fake.refunds.values()].map((r) => r.paymentId)).toEqual([payment.id]);
		expect((await record(env, payment.id)).refundDue).toBe(false);
	});

	it("does not invoice a verification payment it refunds", async () => {
		const getRecipient = vi.fn(async () => ({
			type: "consumer" as const,
			givenName: "Ada",
			familyName: "Lovelace",
			email: "ada@example.com",
			streetAndNumber: "Keizersgracht 1",
			postalCode: "1015 CJ",
			city: "Amsterdam",
			country: "NL",
			locale: "nl_NL" as const,
		}));
		const env = await setup({
			subscription: {
				refundVerificationPayment: true,
				tax: { calculate: () => ({ rate: "21.00", country: "NL" }) },
			},
			options: {
				salesInvoices: { enabled: true, getRecipient, invoiceVerificationPayments: true },
			},
		});
		await startTrial(env);
		await settle();
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.salesInvoices.size).toBe(0);
		expect(getRecipient).not.toHaveBeenCalled();
	});

	describe("payments recorded before they carried a purpose", () => {
		it("still refunds a verification that a renewal settles", async () => {
			const env = await setup({ subscription: { refundVerificationPayment: true } });
			env.fake.failNext("refunds.create", new TypeError("fetch failed"));
			const { payment, subscription } = await startTrial(env);
			await env.context.adapter.update({
				model: "molliePayment",
				where: [{ field: "molliePaymentId", value: payment.id }],
				update: { outcome: "pending", refundDue: false, purpose: null },
			});
			travel(new Date(subscription.trialEnd!).getTime() + 3_600_000);
			const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
			await env.webhook(`id=${renewal.id}`);
			expect(await record(env, payment.id)).toMatchObject({ outcome: "applied", refundDue: true });

			await syncMollieSubscriptions(env.auth as never);
			expect([...env.fake.refunds.values()].map((r) => r.paymentId)).toEqual([payment.id]);
		});

		it("get their purpose when they are processed again", async () => {
			const env = await setup();
			const { payment } = await startTrial(env);
			await env.context.adapter.update({
				model: "molliePayment",
				where: [{ field: "molliePaymentId", value: payment.id }],
				update: { purpose: null },
			});
			await env.webhook(`id=${payment.id}`);
			expect((await record(env, payment.id)).purpose).toBe("verification");
		});
	});
});
