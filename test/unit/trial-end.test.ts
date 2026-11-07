/**
 * `getTrialEnd`: the app decides when a new subscription's trial ends, e.g.
 * a trial that started when the organization was created.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ceilToUTCDate, toMollieDate } from "../../src/utils";
import { setup, travel } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

const DAY = 24 * 3_600_000;

async function payCheckout(env: Awaited<ReturnType<typeof setup>>, plan: string, body = {}) {
	const { payment } = await env.checkout(plan, body);
	env.fake.completePayment(payment.id, "paid");
	await env.webhook(`id=${payment.id}`);
	const [subscription] = await env.subscriptions();
	return { payment, subscription: subscription! };
}

describe("subscription.getTrialEnd", () => {
	it("gives a trial until the date it returns, also on a plan without one", async () => {
		const end = new Date(Date.now() + 10 * DAY);
		const getTrialEnd = vi.fn(async (_data: unknown) => end);
		const env = await setup({ subscription: { getTrialEnd } });
		const { payment, subscription } = await payCheckout(env, "starter");

		expect(payment).toMatchObject({
			amount: { value: "0.02" },
			metadata: expect.objectContaining({ trial: true, trialEnd: end.toISOString() }),
		});
		expect(subscription.status).toBe("trialing");
		expect(new Date(subscription.trialEnd!)).toEqual(ceilToUTCDate(end));
		const [remote] = env.fake.activeSubscriptionsFor(subscription.mollieCustomerId!);
		expect(remote?.startDate).toBe(toMollieDate(ceilToUTCDate(end)));
		expect(getTrialEnd.mock.calls[0]![0]).toMatchObject({
			referenceId: subscription.referenceId,
			customerType: "user",
			plan: { name: "starter" },
		});
	});

	it("gives no trial for null, even on a plan with one", async () => {
		const env = await setup({ subscription: { getTrialEnd: async () => null } });
		const { payment, subscription } = await payCheckout(env, "pro");
		expect(payment.amount.value).toBe("29.00");
		expect(subscription).toMatchObject({ status: "active", trialEnd: null });
	});

	it("gives no trial for a date that has passed", async () => {
		const env = await setup({
			subscription: { getTrialEnd: async () => new Date(Date.now() - DAY) },
		});
		const { subscription } = await payCheckout(env, "pro");
		expect(subscription.status).toBe("active");
	});

	it("leaves the plan's trial for undefined", async () => {
		const env = await setup({ subscription: { getTrialEnd: async () => undefined } });
		const { payment, subscription } = await payCheckout(env, "pro");
		expect(payment.amount.value).toBe("0.02");
		expect(subscription.status).toBe("trialing");
	});

	it("starts billing from the next UTC date when the verification is paid after the trial ended", async () => {
		const end = new Date(Date.now() + 3_600_000);
		const env = await setup({ subscription: { getTrialEnd: async () => end } });
		const { payment } = await env.checkout("starter");
		travel(Date.now() + 2 * 3_600_000);
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		const [subscription] = await env.subscriptions();
		const paidAt = new Date(env.fake.payments.get(payment.id)!.paidAt!);
		expect(new Date(subscription!.trialEnd!)).toEqual(ceilToUTCDate(paidAt));
	});

	it("cannot be extended through the checkout's metadata", async () => {
		const env = await setup();
		const { subscription } = await payCheckout(env, "pro", {
			metadata: { trialEnd: new Date(Date.now() + 365 * DAY).toISOString() },
		});
		const trialEnd = new Date(subscription.trialEnd!).getTime();
		expect(trialEnd).toBeLessThan(Date.now() + 16 * DAY);
	});

	it("rejects a value that is not a date", async () => {
		const env = await setup({
			subscription: { getTrialEnd: async () => "2027-01-01" as never },
		});
		await expect(env.checkout("starter")).rejects.toBeTruthy();
		expect(env.fake.callsTo("payments.create")).toEqual([]);
	});

	describe("when the app changes the trial end before payment", () => {
		async function changing() {
			let end = new Date(Date.now() + 20 * DAY);
			const env = await setup({ subscription: { getTrialEnd: async () => end } });
			return { env, change: (to: Date) => (end = to) };
		}

		it("does not reuse the open checkout of the earlier trial", async () => {
			const { env, change } = await changing();
			const first = await env.checkout("starter");
			const shorter = change(new Date(Date.now() + 2 * DAY));
			const second = await env.checkout("starter");
			expect(second.payment.id).not.toBe(first.payment.id);
			env.fake.completePayment(second.payment.id, "paid");
			await env.webhook(`id=${second.payment.id}`);
			const [subscription] = await env.subscriptions();
			expect(new Date(subscription!.trialEnd!)).toEqual(ceilToUTCDate(shorter));
		});

		it("does not recover a lost checkout of the earlier trial", async () => {
			const { env, change } = await changing();
			env.fake.loseNextResponse("payments.create");
			await expect(env.checkout("starter")).rejects.toBeTruthy();
			const shorter = change(new Date(Date.now() + 2 * DAY));
			const { payment } = await env.checkout("starter");
			expect((payment.metadata as { trialEnd?: string }).trialEnd).toBe(shorter.toISOString());
		});
	});
});
