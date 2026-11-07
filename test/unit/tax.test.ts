import { describe, expect, it, vi } from "vitest";
import { computeTax } from "../../src/tax";
import { euVat } from "../../src/vat";
import { settle, setup } from "../helpers/setup";

describe("computeTax", () => {
	it("adds VAT to net prices, rounding half up to whole cents", () => {
		expect(computeTax("9.95", "EUR", { rate: "21.00" }, false)).toMatchObject({
			net: "9.95",
			vat: "2.09",
			gross: "12.04",
			inclusive: false,
		});
		expect(computeTax("10.05", "EUR", { rate: "20.00" }, false)).toMatchObject({
			vat: "2.01",
			gross: "12.06",
		});
	});

	it("takes VAT out of inclusive prices, keeping the gross amount exact", () => {
		const tax = computeTax("12.10", "EUR", { rate: "21.00" }, true);
		expect(tax).toMatchObject({ net: "10.00", vat: "2.10", gross: "12.10", inclusive: true });
		const odd = computeTax("10.05", "EUR", { rate: "20.00" }, true);
		expect(Number(odd.net) + Number(odd.vat)).toBeCloseTo(10.05, 10);
		expect(odd.gross).toBe("10.05");
	});

	it("charges no VAT for reverse charge", () => {
		expect(
			computeTax("9.95", "EUR", { rate: "21.00", reverseCharge: true, country: "BE" }, false),
		).toMatchObject({
			rate: "0.00",
			vat: "0.00",
			gross: "9.95",
			reverseCharge: true,
			country: "BE",
		});
	});

	it("rejects malformed rates", () => {
		expect(() => computeTax("9.95", "EUR", { rate: "21%" }, false)).toThrow(/VAT rate/);
	});
});

describe("euVat (offline: VIES off)", () => {
	const ctx = { context: { logger: { warn: vi.fn() } } } as never;
	const plan = { name: "pro", amount: "10.00", interval: "1 month" as const };
	const decide = (customer: { country: string; vatNumber?: string } | null, extra = {}) =>
		euVat({ originCountry: "NL", vies: false, getCustomer: () => customer, ...extra }).calculate(
			{ referenceId: "org_1", customerType: "organization", plan },
			ctx,
		);

	it("charges EU consumers the VAT of their country", async () => {
		expect(await decide({ country: "DE" })).toEqual({
			rate: "19.00",
			country: "DE",
			reverseCharge: false,
		});
		expect(await decide({ country: "NL" })).toMatchObject({ rate: "21.00" });
	});

	it("reverse charges businesses in another EU country", async () => {
		expect(await decide({ country: "BE", vatNumber: "BE 0403.170.701" })).toEqual({
			rate: "0.00",
			country: "BE",
			reverseCharge: true,
		});
	});

	it("charges domestic businesses normally", async () => {
		expect(await decide({ country: "NL", vatNumber: "NL004495445B01" })).toMatchObject({
			rate: "21.00",
			reverseCharge: false,
		});
	});

	it("treats invalid VAT numbers as consumers", async () => {
		expect(await decide({ country: "BE", vatNumber: "BE123" })).toMatchObject({
			rate: "21.00",
			reverseCharge: false,
		});
	});

	it("charges nothing outside the EU unless registered there", async () => {
		expect(await decide({ country: "US" })).toMatchObject({ rate: "0.00" });
		expect(await decide({ country: "CH" })).toMatchObject({ rate: "0.00" });
		expect(await decide({ country: "CH" }, { registeredCountries: ["CH"] })).toMatchObject({
			rate: "8.10",
		});
	});

	it("uses the home rate for EU consumers below the OSS threshold", async () => {
		expect(await decide({ country: "DE" }, { belowOssThreshold: true })).toMatchObject({
			rate: "21.00",
			country: "DE",
		});
	});

	it("charges home VAT for unknown customers", async () => {
		expect(await decide(null)).toMatchObject({ rate: "21.00", country: "NL" });
	});
});

describe("tax in the subscription flow", () => {
	it("charges net + VAT and passes the breakdown to hooks and renewals", async () => {
		const env = await setup({
			subscription: {
				tax: { calculate: () => ({ rate: "21.00", country: "NL" }) },
			},
		});
		const { payment } = await env.checkout("starter");
		expect(payment.amount.value).toBe("12.04");
		expect(payment.metadata).toMatchObject({
			vatRate: "21.00",
			netAmount: "9.95",
			vatAmount: "2.09",
			grossAmount: "12.04",
		});
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		const [mollieSubscription] = [...env.fake.subscriptions.values()];
		expect(mollieSubscription?.amount.value).toBe("12.04");
		expect(mollieSubscription?.metadata).toMatchObject({ vatRate: "21.00", netAmount: "9.95" });
		await settle();
		expect(env.hooks.onPaymentPaid.mock.calls[0]![0]).toMatchObject({
			tax: { net: "9.95", vat: "2.09", gross: "12.04", rate: "21.00", country: "NL" },
		});
	});

	it("keeps the verification amount of a trial untaxed", async () => {
		const env = await setup({
			subscription: { tax: { calculate: () => ({ rate: "21.00" }) } },
		});
		const { payment } = await env.checkout("pro");
		expect(payment.amount.value).toBe("0.02");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		expect([...env.fake.subscriptions.values()][0]?.amount.value).toBe("35.09");
		await settle();
		expect(env.hooks.onPaymentPaid.mock.calls[0]![0]).toMatchObject({ tax: null });
	});
});
