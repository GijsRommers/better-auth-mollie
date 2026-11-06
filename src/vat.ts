import type { GenericEndpointContext } from "better-auth";
import salesTax from "sales-tax";
import type { CustomerType, TaxDecision, TaxOptions } from "./types";
import { errorMessage } from "./utils";

/** EU member states (ISO 3166-1 alpha-2). */
export const EU_COUNTRIES: readonly string[] = [
	"AT",
	"BE",
	"BG",
	"CY",
	"CZ",
	"DE",
	"DK",
	"EE",
	"ES",
	"FI",
	"FR",
	"GR",
	"HR",
	"HU",
	"IE",
	"IT",
	"LT",
	"LU",
	"LV",
	"MT",
	"NL",
	"PL",
	"PT",
	"RO",
	"SE",
	"SI",
	"SK",
];

export type VatCustomer = {
	/** ISO 3166-1 alpha-2 country, e.g. `"BE"`. */
	country: string;
	/** VAT number for business customers, e.g. `"BE0403170701"`. */
	vatNumber?: string | null | undefined;
};

export type EuVatOptions = {
	/** The country you sell from, e.g. `"NL"`. */
	originCountry: string;
	/**
	 * Look up the billing country and VAT number of a reference (from your own
	 * user or organization data). Returning `null` charges your own country's
	 * VAT, which is the safe default for an unknown customer.
	 */
	getCustomer: (
		data: { referenceId: string; customerType: CustomerType },
		ctx: GenericEndpointContext,
	) => VatCustomer | null | Promise<VatCustomer | null>;
	/** Plan amounts include VAT. @default false */
	pricesIncludeVat?: boolean | undefined;
	/**
	 * Check VAT numbers online with VIES (Node.js only) instead of only their
	 * format. If VIES is unreachable, VAT is charged and a warning is logged.
	 * @default false
	 */
	vies?: boolean | undefined;
	/**
	 * Your EU-wide B2C sales are below the €10,000 OSS threshold: charge your
	 * own country's rate to EU consumers instead of theirs.
	 * @default false
	 */
	belowOssThreshold?: boolean | undefined;
	/**
	 * Non-EU countries where you are VAT-registered and charge local VAT, e.g.
	 * `["GB", "CH", "NO"]`. Other non-EU customers pay no VAT.
	 * @default []
	 */
	registeredCountries?: readonly string[] | undefined;
};

function percent(rate: number): string {
	return (Math.round(rate * 10000) / 100).toFixed(2);
}

/**
 * VAT for an EU-based seller, powered by the `sales-tax` package:
 *
 * - EU consumers pay the VAT of their country (OSS), or yours below the OSS
 *   threshold.
 * - EU businesses in another member state with a valid VAT number are
 *   reverse charged (0%). Domestic businesses pay your VAT.
 * - Customers outside the EU pay no VAT unless you list their country in
 *   `registeredCountries`.
 *
 * ```ts
 * import { euVat } from "better-auth-mollie/vat";
 *
 * subscription: {
 *   tax: euVat({
 *     originCountry: "NL",
 *     getCustomer: async ({ referenceId }) => {
 *       const org = await db.organization.findUnique({ where: { id: referenceId } });
 *       return org && { country: org.country, vatNumber: org.vatNumber };
 *     },
 *   }),
 * }
 * ```
 *
 * `sales-tax` keeps its settings globally, so use one origin country per
 * process. Rates come from the package's bundled tables; keep it updated.
 */
export function euVat(options: EuVatOptions): TaxOptions {
	const origin = options.originCountry.toUpperCase();
	const registered = new Set((options.registeredCountries ?? []).map((c) => c.toUpperCase()));

	return {
		pricesIncludeVat: options.pricesIncludeVat ?? false,
		async calculate({ referenceId, customerType }, ctx): Promise<TaxDecision> {
			salesTax.setTaxOriginCountry(origin);
			salesTax.toggleEnabledTaxNumberValidation(true);
			salesTax.toggleEnabledTaxNumberFraudCheck(options.vies === true);

			const customer = await options.getCustomer({ referenceId, customerType }, ctx);
			const country = (customer?.country ?? origin).toUpperCase();
			const vatNumber = customer?.vatNumber?.replace(/\s+/g, "") || undefined;
			const inEU = EU_COUNTRIES.includes(country);

			if (!inEU && !registered.has(country)) {
				return { rate: "0.00", country, reverseCharge: false };
			}

			let result: Awaited<ReturnType<typeof salesTax.getSalesTax>>;
			try {
				result = await salesTax.getSalesTax(country, null, vatNumber);
			} catch (error) {
				// VIES unreachable: charge VAT rather than block the checkout.
				ctx.context.logger.warn(
					`[mollie] VAT number check failed for ${referenceId}, charging VAT: ${errorMessage(error)}`,
				);
				result = await salesTax.getSalesTax(country, null);
			}

			if (result.charge.reverse) return { rate: "0.00", country, reverseCharge: true };
			if (inEU && options.belowOssThreshold && result.exchange === "consumer") {
				const home = await salesTax.getSalesTax(origin, null);
				return { rate: percent(home.rate), country, reverseCharge: false };
			}
			return { rate: percent(result.rate), country, reverseCharge: false };
		},
	};
}
