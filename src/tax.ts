import type { GenericEndpointContext } from "better-auth";
import type { CustomerType, MollieOptions, MolliePlan, TaxBreakdown, TaxDecision } from "./types";
import { planCurrency } from "./utils";

const RATE_PATTERN = /^\d{1,2}\.\d{2}$/;

/** `"9.95"` → `995`, without floating point. */
export function toCents(amount: string): number {
	const [whole = "0", fraction = "00"] = amount.split(".");
	return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

export function fromCents(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** `"21.00"` → `2100` basis points. */
function rateBasisPoints(rate: string): number {
	if (!RATE_PATTERN.test(rate)) {
		throw new Error(
			`Invalid VAT rate "${rate}". Use a percentage with two decimals, e.g. "21.00".`,
		);
	}
	return toCents(rate);
}

/**
 * Splits a plan amount into net, VAT and gross for a tax decision. Amounts
 * are rounded half-up to whole cents; VAT is computed on the net amount.
 */
export function computeTax(
	amount: string,
	currency: string,
	decision: TaxDecision,
	pricesIncludeVat: boolean,
): TaxBreakdown {
	const reverseCharge = decision.reverseCharge === true;
	const rate = reverseCharge ? "0.00" : decision.rate;
	const bp = rateBasisPoints(rate);
	const cents = toCents(amount);
	let net: number;
	let vat: number;
	if (pricesIncludeVat) {
		net = Math.round((cents * 10000) / (10000 + bp));
		vat = cents - net;
	} else {
		net = cents;
		vat = Math.round((net * bp) / 10000);
	}
	return {
		rate,
		net: fromCents(net),
		vat: fromCents(vat),
		gross: fromCents(net + vat),
		currency,
		country: decision.country,
		reverseCharge,
		inclusive: pricesIncludeVat,
	};
}

/**
 * Asks the app for the tax decision and returns the breakdown for `amount`
 * (the plan amount by default), or `null` when no `subscription.tax` is
 * configured.
 */
export async function resolveTax(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	data: { referenceId: string; customerType: CustomerType; plan: MolliePlan },
	amount: string = data.plan.amount,
): Promise<TaxBreakdown | null> {
	const tax = options.subscription?.enabled ? options.subscription.tax : undefined;
	if (!tax) return null;
	const decision = await tax.calculate(data, ctx);
	return computeTax(amount, planCurrency(data.plan), decision, tax.pricesIncludeVat ?? false);
}

/** The amount Mollie should charge for a plan. */
export function chargeAmount(plan: MolliePlan, tax: TaxBreakdown | null): string {
	return tax?.gross ?? plan.amount;
}

/**
 * Metadata keys stored on the first payment and the Mollie subscription.
 * Mollie forwards subscription metadata to every recurring payment, so each
 * payment carries the tax treatment it was charged with.
 */
export function taxMetadata(tax: TaxBreakdown | null): Record<string, unknown> {
	if (!tax) return {};
	return {
		vatRate: tax.rate,
		netAmount: tax.net,
		vatAmount: tax.vat,
		grossAmount: tax.gross,
		reverseCharge: tax.reverseCharge,
		vatInclusive: tax.inclusive,
		...(tax.country ? { vatCountry: tax.country } : {}),
	};
}

export function taxFromMetadata(
	metadata: Record<string, unknown>,
	currency: string,
): TaxBreakdown | null {
	const { vatRate, netAmount, vatAmount, grossAmount } = metadata;
	if (
		typeof vatRate !== "string" ||
		typeof netAmount !== "string" ||
		typeof vatAmount !== "string" ||
		typeof grossAmount !== "string"
	) {
		return null;
	}
	return {
		rate: vatRate,
		net: netAmount,
		vat: vatAmount,
		gross: grossAmount,
		currency,
		country: typeof metadata.vatCountry === "string" ? metadata.vatCountry : undefined,
		reverseCharge: metadata.reverseCharge === true,
		inclusive: metadata.vatInclusive === true,
	};
}

/**
 * The tax breakdown a payment or Mollie subscription was charged with, read
 * from the metadata the plugin set. Ignored when no `subscription.tax` is
 * configured, so stray metadata can never change prices.
 */
export function trustedTax(
	options: MollieOptions,
	metadata: Record<string, unknown>,
	currency: string,
): TaxBreakdown | null {
	const configured = options.subscription?.enabled && !!options.subscription.tax;
	return configured ? taxFromMetadata(metadata, currency) : null;
}
