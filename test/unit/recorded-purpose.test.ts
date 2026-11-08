/**
 * The purpose recorded with a payment wins over its Mollie metadata, so a
 * payment imported from another billing system (whose metadata the plugin
 * never set) is handled as what it was.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { settle, setup, subscribe, type TestEnv, travel } from "../helpers/setup";

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

	describe("when it disagrees with the payment's trial terms", () => {
		const setPurpose = (env: TestEnv, id: string, purpose: string) =>
			env.context.adapter.update({
				model: "molliePayment",
				where: [{ field: "molliePaymentId", value: id }],
				update: { purpose },
			});
		const expectNothingStarted = async (env: TestEnv) => {
			expect((await env.subscriptions())[0]).toMatchObject({ status: "incomplete" });
			expect(env.fake.refunds.size).toBe(0);
			expect(env.fake.callsTo("subscriptions.create")).toEqual([]);
		};

		it("does not start a paid period from a recorded verification without trial terms", async () => {
			const env = await setup({ subscription: { refundVerificationPayment: true } });
			const { payment } = await env.checkout("pro");
			env.fake.payments.get(payment.id)!.metadata = {
				...(payment.metadata as object),
				trial: false,
				trialDays: 0,
			};
			env.fake.completePayment(payment.id, "paid");
			await env.webhook(`id=${payment.id}`);
			await expectNothingStarted(env);
		});

		it("does not start a paid period from a trial's payment recorded as a checkout", async () => {
			const env = await setup();
			const { payment } = await env.checkout("pro");
			await setPurpose(env, payment.id, "checkout");
			env.fake.completePayment(payment.id, "paid");
			await env.webhook(`id=${payment.id}`);
			await expectNothingStarted(env);
		});

		it("is compared when an open checkout could be reused", async () => {
			const env = await setup();
			const subscription = await subscribe(env);
			travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
			const failed = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "failed");
			await env.webhook(`id=${failed.id}`);
			const { headers } = await env.signInWithTestUser();
			const recover = () => env.api.upgradeSubscription({ body: { plan: "starter" }, headers });
			const latest = () => [...env.fake.payments.values()].at(-1)!;

			await recover();
			const first = latest();
			expect(first).toMatchObject({ metadata: expect.objectContaining({ purpose: "recovery" }) });
			await recover();
			expect(latest().id).toBe(first.id);

			await setPurpose(env, first.id, "checkout");
			await recover();
			expect(latest().id).not.toBe(first.id);
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
