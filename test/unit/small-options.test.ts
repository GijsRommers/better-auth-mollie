/**
 * Smaller options and fields: the payment's creation time and invoice id,
 * server-only endpoints, lazily loaded plans, the reverse-charge memo and
 * `willBeCharged`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions, willBeCharged } from "../../src";
import { AUTH_URL, PLANS, settle, setup, subscribe, travel } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

const recipient = async () => ({
	type: "business" as const,
	organizationName: "Acme BV",
	email: "billing@acme.test",
	streetAndNumber: "Rue de la Loi 1",
	postalCode: "1000",
	city: "Brussels",
	country: "BE",
	locale: "nl_BE" as const,
});

describe("payment records", () => {
	it("keep when Mollie created the payment", async () => {
		const env = await setup();
		await subscribe(env);
		const [payment] = [...env.fake.payments.values()];
		const [record] = await env.payments();
		expect(new Date(record!.createdAt!)).toEqual(new Date(payment!.createdAt));
	});

	it("keep the id of their sales invoice", async () => {
		const env = await setup({
			subscription: { tax: { calculate: () => ({ rate: "21.00", country: "NL" }) } },
			options: { salesInvoices: { enabled: true, getRecipient: recipient } },
		});
		await subscribe(env);
		await settle();
		const [invoice] = [...env.fake.salesInvoices.values()];
		const [record] = await env.payments();
		expect(record).toMatchObject({ invoice: "created", salesInvoiceId: invoice!.id });
	});
});

describe("salesInvoices.reverseChargeMemo", () => {
	it("is the memo of a reverse-charged invoice", async () => {
		const env = await setup({
			subscription: {
				tax: { calculate: () => ({ rate: "0.00", reverseCharge: true, country: "BE" }) },
			},
			options: {
				salesInvoices: {
					enabled: true,
					getRecipient: recipient,
					reverseChargeMemo: "Btw verlegd (art. 196 Btw-richtlijn)",
				},
			},
		});
		await subscribe(env);
		await settle();
		const [invoice] = [...env.fake.salesInvoices.values()];
		expect(invoice!.request).toMatchObject({ memo: "Btw verlegd (art. 196 Btw-richtlijn)" });
	});
});

describe("subscription.serverOnly", () => {
	const overHttp = (env: Awaited<ReturnType<typeof setup>>, path: string, body: unknown) =>
		env.auth.handler(
			new Request(`${AUTH_URL}${path}`, {
				method: "POST",
				headers: { cookie: env.headers.get("cookie") ?? "", "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	it("keeps upgrade, cancel and restore off HTTP, and on auth.api", async () => {
		const env = await setup({ subscription: { serverOnly: true } });
		for (const path of ["/subscription/upgrade", "/subscription/cancel", "/subscription/restore"]) {
			expect((await overHttp(env, path, { plan: "starter", returnUrl: "/" })).status).toBe(404);
		}
		await expect(env.checkout("starter")).resolves.toBeTruthy();
	});

	it("leaves them on HTTP by default", async () => {
		const env = await setup();
		const response = await overHttp(env, "/subscription/upgrade", { plan: "starter" });
		expect(response.status).toBe(200);
	});
});

describe("a plans function", () => {
	it("is not called when Better Auth starts, only when plans are needed", async () => {
		const plans = vi.fn(async () => PLANS);
		const env = await setup({ subscription: { plans } });
		expect(plans).not.toHaveBeenCalled();
		await env.checkout("starter");
		expect(plans).toHaveBeenCalled();
	});

	it("is checked when it is called", async () => {
		const env = await setup({
			subscription: { plans: async () => [{ name: "broken", amount: "9.9", interval: "1 month" }] },
		});
		await expect(env.checkout("broken")).rejects.toBeTruthy();
		expect(env.fake.callsTo("payments.create")).toEqual([]);
	});
});

describe("when the plans provider fails or is invalid", () => {
	function flaky() {
		let mode: "ok" | "down" | "invalid" = "ok";
		return {
			plans: async () => {
				if (mode === "down") throw new Error("plans are down");
				if (mode === "invalid") return PLANS.map((plan) => ({ ...plan, amount: "9.9" }));
				return PLANS;
			},
			set: (to: typeof mode) => {
				mode = to;
			},
		};
	}

	it("keeps a payment's hooks due until they can be built", async () => {
		const provider = flaky();
		const env = await setup({ subscription: { plans: provider.plans } });
		const { payment } = await env.checkout("starter");
		provider.set("down");
		env.fake.completePayment(payment.id, "failed");
		await env.webhook(`id=${payment.id}`);
		await settle();
		expect(env.hooks.onPaymentFailed).not.toHaveBeenCalled();

		provider.set("ok");
		await env.webhook(`id=${payment.id}`);
		await settle();
		expect(env.hooks.onPaymentFailed).toHaveBeenCalledTimes(1);
	});

	it("keeps a chargeback's hook due until it can be built", async () => {
		const provider = flaky();
		const onChargeback = vi.fn(async (..._args: any[]) => {});
		const env = await setup({ subscription: { plans: provider.plans, onChargeback } });
		const subscription = await subscribe(env);
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		await env.webhook(`id=${renewal.id}`);
		env.fake.chargeBack(renewal.id);
		provider.set("down");
		await env.webhook(`id=${renewal.id}`);
		await settle();
		expect(onChargeback).not.toHaveBeenCalled();

		provider.set("ok");
		await env.webhook(`id=${renewal.id}`);
		await settle();
		expect(onChargeback).toHaveBeenCalledTimes(1);
	});

	it("still processes payments with invalid plans, and refuses new checkouts", async () => {
		const provider = flaky();
		const env = await setup({ subscription: { plans: provider.plans } });
		const subscription = await subscribe(env);
		provider.set("invalid");
		travel(new Date(subscription.periodEnd!).getTime() + 3_600_000);
		const renewal = env.fake.chargeSubscription(subscription.mollieSubscriptionId!, "paid");
		expect((await env.webhook(`id=${renewal.id}`)).status).toBe(200);
		const renewed = await env.subscription(subscription.id);
		expect(new Date(renewed.periodEnd!).getTime()).toBeGreaterThan(
			new Date(subscription.periodEnd!).getTime(),
		);
		await expect(
			env.api.upgradeSubscription({
				body: { plan: "business" },
				headers: (await env.signInWithTestUser()).headers,
			}),
		).rejects.toBeTruthy();
	});
});

describe("the invoice catch-up", () => {
	it("repairs a payment whose invoice was created but not recorded", async () => {
		const env = await setup({
			subscription: { tax: { calculate: () => ({ rate: "21.00", country: "NL" }) } },
			options: { salesInvoices: { enabled: true, getRecipient: recipient } },
		});
		await subscribe(env);
		await settle();
		const [invoice] = [...env.fake.salesInvoices.values()];
		const [record] = await env.payments();
		await env.context.adapter.update({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: record!.molliePaymentId }],
			update: { invoice: null, salesInvoiceId: null },
		});
		await syncMollieSubscriptions(env.auth as never);
		const [repaired] = await env.payments();
		expect(repaired).toMatchObject({ invoice: "created", salesInvoiceId: invoice!.id });
		expect(env.fake.salesInvoices.size).toBe(1);
	});
});

describe("willBeCharged", () => {
	it("is true for a billing subscription that is not canceled", () => {
		expect(willBeCharged({ status: "active", cancelAtPeriodEnd: false })).toBe(true);
		expect(willBeCharged({ status: "unpaid", cancelAtPeriodEnd: false })).toBe(true);
		expect(willBeCharged({ status: "active", cancelAtPeriodEnd: true })).toBe(false);
		expect(willBeCharged({ status: "canceled", cancelAtPeriodEnd: false })).toBe(false);
		expect(willBeCharged({ status: "incomplete", cancelAtPeriodEnd: false })).toBe(false);
	});
});
