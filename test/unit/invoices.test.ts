import { afterEach, describe, expect, it, vi } from "vitest";
import { mollie, syncMollieSubscriptions } from "../../src";
import { createFakeMollie, mollieError } from "../helpers/fake-mollie";
import { PLANS, settle, setup } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

const recipient = {
	type: "business" as const,
	organizationName: "Acme BV",
	vatNumber: "NL004495445B01",
	email: "billing@acme.test",
	streetAndNumber: "Keizersgracht 1",
	postalCode: "1015 CJ",
	city: "Amsterdam",
	country: "NL",
	locale: "nl_NL" as const,
};

async function invoicingSetup(extra: { pricesIncludeVat?: boolean; onInvoiceCreated?: any } = {}) {
	return setup({
		subscription: {
			tax: {
				pricesIncludeVat: extra.pricesIncludeVat,
				calculate: () => ({ rate: "21.00", country: "NL" }),
			},
		},
		options: {
			salesInvoices: {
				enabled: true,
				eInvoice: true,
				getRecipient: () => recipient,
				onInvoiceCreated: extra.onInvoiceCreated,
			},
		},
	});
}

describe("sales invoices", () => {
	it("creates a paid invoice for each paid payment", async () => {
		const onInvoiceCreated = vi.fn(async () => {});
		const env = await invoicingSetup({ onInvoiceCreated });
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		await settle();

		const [invoice] = [...env.fake.salesInvoices.values()];
		expect(invoice?.request).toMatchObject({
			status: "paid",
			recipientIdentifier: env.user.id,
			recipient,
			vatMode: "exclusive",
			isEInvoice: true,
			paymentDetails: { source: "payment", sourceReference: payment.id },
			lines: [
				{
					quantity: 1,
					vatRate: "21.00",
					unitPrice: { currency: "EUR", value: "9.95" },
				},
			],
			metadata: { molliePaymentId: payment.id },
		});
		expect(onInvoiceCreated).toHaveBeenCalledTimes(1);
	});

	it("invoices VAT-inclusive prices as charged, so totals always match", async () => {
		const env = await invoicingSetup({ pricesIncludeVat: true });
		const { payment } = await env.checkout("starter");
		expect(payment.amount.value).toBe("9.95");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		await settle();
		const [invoice] = [...env.fake.salesInvoices.values()];
		expect(invoice?.request).toMatchObject({
			vatMode: "inclusive",
			lines: [{ vatRate: "21.00", unitPrice: { value: "9.95" } }],
		});
	});

	it("skips trial verification payments and never invoices a payment twice", async () => {
		const env = await invoicingSetup();
		const { payment } = await env.checkout("pro");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		await env.webhook(`id=${payment.id}`);
		await settle();
		expect(env.fake.salesInvoices.size).toBe(0);
	});

	it("catches up on an invoice that failed, from the cron", async () => {
		const env = await invoicingSetup();
		env.fake.failNext("salesInvoices.create", mollieError(503));
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		await settle();
		expect(env.fake.salesInvoices.size).toBe(0);

		// Past the journal's in-flight window, so the failed attempt can be retried.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60 * 60 * 1000);
		const result = await syncMollieSubscriptions(env.auth as never);
		expect(result.invoicesCreated).toBe(1);
		expect(env.fake.salesInvoices.size).toBe(1);
		const again = await syncMollieSubscriptions(env.auth as never);
		expect(again.invoicesCreated).toBe(0);
		expect(env.fake.salesInvoices.size).toBe(1);
	});

	it("requires a VAT rate when no tax is configured", () => {
		expect(() =>
			mollie({
				mollieClient: createFakeMollie().client,
				subscription: { enabled: true, plans: PLANS, customerType: "user" },
				salesInvoices: { enabled: true, getRecipient: () => recipient },
			}),
		).toThrow(/VAT rate/);
	});
});
