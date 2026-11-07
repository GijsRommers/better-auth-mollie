import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { mollie } from "better-auth-mollie";
import { Client } from "mollie-api-typescript";
import { building } from "$app/environment";
import { getRequestEvent } from "$app/server";
import { env } from "$env/dynamic/private";
import { plans } from "$lib/plans";

export const auth = betterAuth({
	baseURL: env.BETTER_AUTH_URL,
	// `vite build` loads this module without the runtime environment.
	secret: building ? "build-time-placeholder-secret-0123456789" : env.BETTER_AUTH_SECRET,
	database: new DatabaseSync(building ? ":memory:" : env.DATABASE_PATH || "sqlite.db"),
	emailAndPassword: { enabled: true },
	plugins: [
		mollie({
			mollieClient: new Client({ security: { apiKey: env.MOLLIE_API_KEY } }),
			webhookUrl: env.MOLLIE_WEBHOOK_URL || undefined,
			createCustomerOnSignUp: true,
			subscription: {
				enabled: true,
				// Bill the signed-in user. For teams, use "organization" with the
				// organization plugin and an `authorizeReference` callback.
				customerType: "user",
				plans,
				// Plan prices are net; this charges Dutch VAT to everyone. For EU
				// rules per customer (OSS, reverse charge), use `euVat()` from
				// "better-auth-mollie/vat" with your customers' billing details.
				tax: { calculate: () => ({ rate: "21.00", country: "NL" }) },
				onSubscriptionActivated: async ({ subscription, plan }) => {
					console.log(`[billing] ${subscription.referenceId} is on ${plan?.name}`);
				},
				onPaymentPaid: async ({ payment, purpose, tax }) => {
					// Create your invoice here, or enable `salesInvoices` below.
					console.log(`[billing] ${purpose} ${payment.id} paid`, tax);
				},
				onPaymentFailed: async ({ payment, subscription }) => {
					console.log(`[billing] ${payment.id} failed; ${subscription.id} is past due`);
				},
			},
		}),
		// Lets server-side `auth.api` calls set cookies (keep it last).
		sveltekitCookies(getRequestEvent),
	],
});
