/**
 * The purpose recorded with a payment wins over its Mollie metadata, so a
 * payment imported from another billing system (whose metadata the plugin
 * never set) is handled as what it was.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { settle, setup, type TestEnv } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

/**
 * A trial whose verification payment looks like an imported one: a first
 * payment without the plugin's metadata, recorded as a verification.
 */
async function importedTrial(env: TestEnv) {
	const { payment } = await env.checkout("pro");
	env.fake.completePayment(payment.id, "paid");
	await env.webhook(`id=${payment.id}`);
	const [subscription] = await env.subscriptions();
	env.fake.payments.get(payment.id)!.metadata = {};
	const [record] = await env.payments();
	expect(record).toMatchObject({ molliePaymentId: payment.id, purpose: "verification" });
	return { payment, subscription: subscription! };
}

describe("the recorded purpose", () => {
	it("keeps a trial whose imported verification payment is charged back", async () => {
		const onChargeback = vi.fn(async (..._args: any[]) => {});
		const env = await setup({ subscription: { onChargeback } });
		const { payment, subscription } = await importedTrial(env);
		expect(subscription.status).toBe("trialing");

		env.fake.chargeBack(payment.id);
		await env.webhook(`id=${payment.id}`);
		expect(await env.subscription(subscription.id)).toMatchObject({
			status: "trialing",
			periodEnd: subscription.periodEnd,
		});
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(1);
		expect(onChargeback.mock.calls[0]![0]).toMatchObject({
			purpose: "verification",
			isVerification: true,
		});
	});

	it("falls back to the metadata for a value it does not know", async () => {
		const onChargeback = vi.fn(async (..._args: any[]) => {});
		const env = await setup({ subscription: { onChargeback } });
		const { payment } = await env.checkout("pro");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: payment.id }],
			update: { purpose: "something-else" },
		});
		env.fake.chargeBack(payment.id);
		await env.webhook(`id=${payment.id}`);
		await settle();
		expect(onChargeback.mock.calls[0]![0]).toMatchObject({ purpose: "verification" });
	});
});
