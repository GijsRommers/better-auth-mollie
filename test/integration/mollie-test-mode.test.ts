/**
 * Integration test against Mollie test mode.
 *
 *   MOLLIE_TEST_API_KEY=test_... pnpm test:integration
 *
 * Needs a test profile with a payment method that supports first payments
 * (credit card by default; set MOLLIE_TEST_METHOD to e.g. "bancontact" if
 * SEPA Direct Debit is enabled) and Playwright's Chromium
 * (`pnpm exec playwright install chromium`).
 *
 * What is real: the Mollie customer, the first payment and its hosted
 * checkout (driven with a headless browser), the mandate, the Mollie
 * subscription, recurring payments and cancellation. What cannot be done
 * on demand in test mode: Mollie's scheduler charging a subscription. The
 * renewal test therefore creates a real recurring payment on the real
 * mandate and links it to the Mollie subscription in a thin client wrapper
 * (a directly created payment cannot carry `subscriptionId`).
 */
import { parseSetCookieHeader } from "better-auth/cookies";
import { getTestInstance } from "better-auth/test";
import { Client } from "mollie-api-typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mollie, syncMollieSubscriptions } from "../../src";
import type { MolliePaymentRecord, Subscription } from "../../src/types";
import { toMollieDate } from "../../src/utils";
import { changePaymentState, closeBrowser, completeCheckout } from "./checkout-driver";

const apiKey = process.env.MOLLIE_TEST_API_KEY;
const method = process.env.MOLLIE_TEST_METHOD || "creditcard";
const BASE_URL = "https://example.com";

/** Mollie test client, plus a way to link a payment to a Mollie subscription. */
function createLinkedClient(key: string) {
	const real = new Client({ security: { apiKey: key } });
	const links = new Map<string, string>();
	const payments = real.payments;
	const linkedPayments = new Proxy(payments, {
		get(target, property, receiver) {
			if (property === "get") {
				return async (...args: Parameters<typeof payments.get>) => {
					const payment = await target.get(...args);
					const subscriptionId = links.get(payment.id);
					return subscriptionId ? { ...payment, subscriptionId } : payment;
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const client = new Proxy(real, {
		get(target, property, receiver) {
			if (property === "payments") return linkedPayments;
			return Reflect.get(target, property, receiver);
		},
	});
	return { client, real, links };
}

describe.skipIf(!apiKey)("Mollie test mode", () => {
	/** Mollie subscriptions created by these tests, cancelled afterwards. */
	const created: Array<{ customerId: string; subscriptionId: string }> = [];
	let env: Awaited<ReturnType<typeof setupReal>>;

	async function setupReal() {
		const { client, real, links } = createLinkedClient(apiKey as string);
		const instance = await getTestInstance(
			{
				baseURL: BASE_URL,
				plugins: [
					mollie({
						mollieClient: client,
						subscription: {
							enabled: true,
							customerType: "user",
							plans: [
								{ name: "starter", amount: "9.95", interval: "1 month" },
								{ name: "trial", amount: "9.95", interval: "1 month", freeTrial: { days: 14 } },
							],
							refundVerificationPayment: true,
							getFirstPaymentParams: () => ({ method: method as never }),
						},
					}),
				],
			},
			{ disableTestUser: true },
		);
		const api = instance.auth.api as any;
		const adapter = ((await instance.auth.$context) as any).adapter;
		let users = 0;
		return {
			...instance,
			real,
			links,
			api,
			adapter,
			async newUser() {
				users++;
				const email = `mollie-it-${Date.now()}-${users}@example.com`;
				await instance.auth.api.signUpEmail({
					body: { email, password: "password1234", name: `Integration ${users}` },
				});
				// An https base URL gives the session cookie a `__Secure-` prefix, which
				// `signInWithUser` does not pick up; forward whatever cookies are set.
				const signedIn = await instance.auth.api.signInEmail({
					body: { email, password: "password1234" },
					returnHeaders: true,
				});
				const cookies = parseSetCookieHeader(signedIn.headers.get("set-cookie") ?? "");
				const headers = new Headers({
					cookie: [...cookies].map(([name, { value }]) => `${name}=${value}`).join("; "),
				});
				return { headers, userId: signedIn.response.user.id as string };
			},
			webhook(id: string) {
				return instance.auth.handler(
					new Request(`${BASE_URL}/api/auth/mollie/webhook`, {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: `id=${id}`,
					}),
				);
			},
			async subscriptionOf(userId: string) {
				const [row] = await adapter.findMany({
					model: "subscription",
					where: [{ field: "referenceId", value: userId }],
				});
				return row as Subscription;
			},
			async firstPaymentOf(subscriptionId: string) {
				const [record] = await adapter.findMany({
					model: "molliePayment",
					where: [{ field: "subscriptionId", value: subscriptionId }],
				});
				return record as MolliePaymentRecord;
			},
		};
	}

	/**
	 * Creates a recurring payment on the subscription's real mandate. A SEPA
	 * mandate from an iDEAL or Bancontact first payment can take a moment to
	 * become usable.
	 */
	async function chargeMandate(subscription: Subscription, description: string) {
		const request = {
			paymentRequest: {
				amount: { currency: "EUR", value: "9.95" },
				description,
				sequenceType: "recurring" as const,
				customerId: subscription.mollieCustomerId as string,
				mandateId: subscription.mollieMandateId as string,
				metadata: { subscriptionId: subscription.id, plan: "starter" },
			},
		};
		// A fresh mandate can take a while to become valid in test mode.
		const deadline = Date.now() + 90_000;
		for (;;) {
			const mandate = await env.real.mandates.get({
				customerId: subscription.mollieCustomerId as string,
				mandateId: subscription.mollieMandateId as string,
			});
			if (mandate.status === "valid" || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		for (let attempt = 0; ; attempt++) {
			try {
				return await env.real.payments.create(request);
			} catch (error) {
				if ((error as { statusCode?: number }).statusCode !== 422 || attempt >= 20) throw error;
				await new Promise((resolve) => setTimeout(resolve, 1500));
			}
		}
	}

	/** Waits until Mollie reports a final status for the payment. */
	async function settled(paymentId: string) {
		for (let attempt = 0; attempt < 30; attempt++) {
			const { status } = await env.real.payments.get({ paymentId });
			if (status !== "open" && status !== "pending" && status !== "authorized") return;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error(`Payment ${paymentId} did not reach a final status`);
	}

	/** Starts a checkout for a new user and completes it with `state`. */
	async function subscribe(state: "paid" | "failed", plan = "starter") {
		const { headers, userId } = await env.newUser();
		const { url } = await env.api.upgradeSubscription({
			body: { plan, successUrl: "/dashboard", cancelUrl: "/pricing" },
			headers,
		});
		expect(url).toMatch(/^https:\/\/www\.mollie\.com\/checkout\//);
		await completeCheckout(url, state);
		const pending = await env.subscriptionOf(userId);
		const record = await env.firstPaymentOf(pending.id);
		// Mollie calls the webhook once the status changed; wait for that too.
		await settled(record.molliePaymentId);
		const response = await env.webhook(record.molliePaymentId);
		expect(response.status).toBe(200);
		const subscription = await env.subscriptionOf(userId);
		if (subscription.mollieSubscriptionId && subscription.mollieCustomerId) {
			created.push({
				customerId: subscription.mollieCustomerId,
				subscriptionId: subscription.mollieSubscriptionId,
			});
		}
		return { headers, userId, subscription, firstPaymentId: record.molliePaymentId };
	}

	beforeAll(async () => {
		env = await setupReal();
	});

	afterAll(async () => {
		await closeBrowser();
		// Leave the test profile without subscriptions that keep "charging".
		for (const { customerId, subscriptionId } of created) {
			const remote = await env.real.subscriptions
				.get({ customerId, subscriptionId })
				.catch(() => undefined);
			if (remote?.status === "active" || remote?.status === "pending") {
				await env.real.subscriptions.cancel({ customerId, subscriptionId }).catch(() => {});
			}
		}
	});

	it("activates after a real paid checkout and schedules the Mollie subscription", async () => {
		const { subscription, firstPaymentId } = await subscribe("paid");
		expect(subscription).toMatchObject({ status: "active", plan: "starter" });
		expect(subscription.mollieMandateId).toMatch(/^mdt_/);
		expect(subscription.mollieSubscriptionId).toMatch(/^sub_/);

		const payment = await env.real.payments.get({ paymentId: firstPaymentId });
		expect(payment).toMatchObject({
			status: "paid",
			sequenceType: "first",
			amount: { value: "9.95", currency: "EUR" },
		});
		const customerId = subscription.mollieCustomerId as string;
		const mandate = await env.real.mandates.get({
			customerId,
			mandateId: subscription.mollieMandateId as string,
		});
		expect(mandate.status).toMatch(/valid|pending/);
		const remote = await env.real.subscriptions.get({
			customerId,
			subscriptionId: subscription.mollieSubscriptionId as string,
		});
		expect(remote).toMatchObject({
			// `pending` while Mollie still confirms the mandate of the first payment.
			status: expect.stringMatching(/^(active|pending)$/),
			interval: "1 month",
			amount: { value: "9.95", currency: "EUR" },
			startDate: toMollieDate(new Date(subscription.periodEnd as Date)),
			mandateId: subscription.mollieMandateId,
		});
		expect(remote.metadata).toMatchObject({ subscriptionId: subscription.id, plan: "starter" });

		// Delivering the webhook again changes nothing.
		await env.webhook(firstPaymentId);
		expect(await env.subscriptionOf(subscription.referenceId)).toMatchObject({
			status: "active",
			mollieSubscriptionId: subscription.mollieSubscriptionId,
		});
	});

	it("expires the checkout when the real first payment fails", async () => {
		const { subscription } = await subscribe("failed");
		expect(subscription.status).toBe("incomplete_expired");
		expect(subscription.mollieSubscriptionId).toBeFalsy();
	});

	it("applies a real recurring payment as a renewal", async () => {
		const { subscription } = await subscribe("paid");
		const payment = await chargeMandate(subscription, "better-auth-mollie integration renewal");
		if (payment.status !== "paid") {
			const url = payment.links.changePaymentState?.href;
			expect(url).toBeTruthy();
			await changePaymentState(url as string, "paid");
		}
		env.links.set(payment.id, subscription.mollieSubscriptionId as string);
		expect((await env.webhook(payment.id)).status).toBe(200);
		const renewed = await env.subscriptionOf(subscription.referenceId);
		expect(renewed.status).toBe("active");
		expect(new Date(renewed.periodEnd as Date).getTime()).toBeGreaterThan(
			new Date(subscription.periodEnd as Date).getTime(),
		);
	});

	it.skipIf(method === "creditcard")(
		"marks past_due when a real recurring payment fails (SEPA mandates only)",
		async () => {
			const { subscription } = await subscribe("paid");
			const payment = await chargeMandate(
				subscription,
				"better-auth-mollie integration failed renewal",
			);
			await changePaymentState(payment.links.changePaymentState?.href as string, "failed");
			env.links.set(payment.id, subscription.mollieSubscriptionId as string);
			await env.webhook(payment.id);
			expect((await env.subscriptionOf(subscription.referenceId)).status).toBe("past_due");
		},
	);

	it("makes the subscription past due when a real renewal is charged back", async () => {
		const { subscription } = await subscribe("paid");
		const payment = await chargeMandate(subscription, "better-auth-mollie integration chargeback");
		if (payment.status !== "paid") {
			await changePaymentState(payment.links.changePaymentState?.href as string, "paid");
		}
		await settled(payment.id);
		env.links.set(payment.id, subscription.mollieSubscriptionId as string);
		await env.webhook(payment.id);
		const renewed = await env.subscriptionOf(subscription.referenceId);
		expect(renewed.status).toBe("active");

		const paid = await env.real.payments.get({ paymentId: payment.id });
		await changePaymentState(paid.links.changePaymentState?.href as string, "chargeback");
		for (let attempt = 0; attempt < 30; attempt++) {
			const current = await env.real.payments.get({ paymentId: payment.id });
			if (current.amountChargedBack) break;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		expect((await env.webhook(payment.id)).status).toBe(200);
		const chargedBack = await env.subscriptionOf(subscription.referenceId);
		expect(chargedBack.status).toBe("past_due");
		expect(new Date(chargedBack.periodEnd as Date)).toEqual(new Date(renewed.periodStart as Date));
		// The sync lists the chargeback too, and finds nothing left to do.
		const result = await syncMollieSubscriptions(env.auth as never);
		expect(result.errors).toEqual([]);
		expect((await env.subscriptionOf(subscription.referenceId)).status).toBe("past_due");
	});

	it("refunds the verification payment of a real trial, and keeps the mandate", async () => {
		const { subscription, firstPaymentId } = await subscribe("paid", "trial");
		expect(subscription).toMatchObject({ status: "trialing", plan: "trial" });
		const payment = await env.real.payments.get({ paymentId: firstPaymentId });
		expect(payment).toMatchObject({ sequenceType: "first", amount: { value: "0.02" } });
		const refunds = await env.real.refunds.list({ paymentId: firstPaymentId });
		expect(refunds.result.embedded?.refunds).toEqual([
			expect.objectContaining({ amount: { currency: "EUR", value: "0.02" } }),
		]);
		const mandate = await env.real.mandates.get({
			customerId: subscription.mollieCustomerId as string,
			mandateId: subscription.mollieMandateId as string,
		});
		expect(mandate.status).toMatch(/valid|pending/);
		const remote = await env.real.subscriptions.get({
			customerId: subscription.mollieCustomerId as string,
			subscriptionId: subscription.mollieSubscriptionId as string,
		});
		expect(remote.startDate).toBe(toMollieDate(new Date(subscription.trialEnd as Date)));
	});

	it("cancels the Mollie subscription at period end, and the cron leaves it consistent", async () => {
		const { subscription, headers } = await subscribe("paid");
		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers });
		const remote = await env.real.subscriptions.get({
			customerId: subscription.mollieCustomerId as string,
			subscriptionId: subscription.mollieSubscriptionId as string,
		});
		expect(remote.status).toBe("canceled");
		expect(await env.subscriptionOf(subscription.referenceId)).toMatchObject({
			status: "active",
			cancelAtPeriodEnd: true,
		});
		const result = await syncMollieSubscriptions(env.auth as never);
		expect(result.errors).toEqual([]);
	});
});
