/**
 * Syncing one user or organization, e.g. from a support "refresh" button:
 * only its subscriptions, each checked at Mollie right away.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMollieSubscriptions } from "../../src";
import type { Subscription } from "../../src/types";
import { settle, setup, subscribe } from "../helpers/setup";

afterEach(() => {
	vi.useRealTimers();
});

describe("syncMollieSubscriptions({ referenceId })", () => {
	it("syncs only that reference's subscriptions", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const other = await env.context.adapter.create<Partial<Subscription>, Subscription>({
			model: "subscription",
			data: {
				referenceId: "someone-else",
				plan: "starter",
				status: "active",
				mollieCustomerId: "cst_someone_else",
				periodEnd: new Date(Date.now() + 10 * 24 * 3_600_000),
				cancelAtPeriodEnd: false,
				mollieSyncNeeded: true,
			},
		});
		const before = env.fake.calls.length;

		const result = await syncMollieSubscriptions(env.auth as never, {
			referenceId: subscription.referenceId,
		});
		expect(result).toMatchObject({ checked: 1, remoteChecked: 1, errors: [] });
		const touchedOther = env.fake.calls
			.slice(before)
			.some((call) => JSON.stringify(call.args).includes("cst_someone_else"));
		expect(touchedOther).toBe(false);
		expect((await env.subscription(other.id)).mollieSyncNeeded).toBe(true);
	});

	it("checks the subscriptions at Mollie right away", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		// Canceled in the Mollie dashboard; nothing tells the plugin.
		env.fake.setSubscriptionStatus(subscription.mollieSubscriptionId!, "canceled");

		// The regular sync leaves a stable subscription alone until its next payment.
		expect(await syncMollieSubscriptions(env.auth as never)).toMatchObject({ remoteChecked: 0 });
		expect((await env.subscription(subscription.id)).cancelAtPeriodEnd).toBe(false);

		const result = await syncMollieSubscriptions(env.auth as never, {
			referenceId: subscription.referenceId,
		});
		expect(result).toMatchObject({ remoteChecked: 1, errors: [] });
		expect((await env.subscription(subscription.id)).cancelAtPeriodEnd).toBe(true);
	});

	it("leaves the profile-wide chargeback listing to the regular sync", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		await syncMollieSubscriptions(env.auth as never, { referenceId: subscription.referenceId });
		expect(env.fake.callsTo("chargebacks.all")).toEqual([]);
		await syncMollieSubscriptions(env.auth as never);
		expect(env.fake.callsTo("chargebacks.all")).toHaveLength(1);
	});

	it("syncs nothing for a reference without subscriptions", async () => {
		const env = await setup();
		await subscribe(env);
		const before = env.fake.calls.length;
		const result = await syncMollieSubscriptions(env.auth as never, { referenceId: "nobody" });
		expect(result).toEqual({ checked: 0, remoteChecked: 0, invoicesCreated: 0, errors: [] });
		expect(env.fake.calls.slice(before)).toEqual([]);
	});

	it("tells a user and an organization with the same id apart", async () => {
		const env = await setup();
		const subscription = await subscribe(env);
		const organizationRow = await env.context.adapter.create<Partial<Subscription>, Subscription>({
			model: "subscription",
			data: {
				referenceId: subscription.referenceId,
				customerType: "organization",
				plan: "starter",
				status: "active",
				mollieCustomerId: "cst_organization",
				periodEnd: new Date(Date.now() + 10 * 24 * 3_600_000),
				cancelAtPeriodEnd: false,
				mollieSyncNeeded: true,
			},
		});
		const before = env.fake.calls.length;
		const result = await syncMollieSubscriptions(env.auth as never, {
			referenceId: subscription.referenceId,
			customerType: "user",
		});
		expect(result).toMatchObject({ checked: 1, errors: [] });
		const touched = env.fake.calls
			.slice(before)
			.some((call) => JSON.stringify(call.args).includes("cst_organization"));
		expect(touched).toBe(false);
		expect((await env.subscription(organizationRow.id)).mollieSyncNeeded).toBe(true);
	});

	it("catches up a reference's invoices in bounded queries", async () => {
		const getRecipient = vi.fn(async () => ({
			type: "consumer" as const,
			givenName: "Ada",
			familyName: "Lovelace",
			email: "ada@example.com",
			streetAndNumber: "Keizersgracht 1",
			postalCode: "1015 CJ",
			city: "Amsterdam",
			country: "NL",
			locale: "nl_NL" as const,
		}));
		const env = await setup({
			subscription: { tax: { calculate: () => ({ rate: "21.00", country: "NL" }) } },
			options: { salesInvoices: { enabled: true, getRecipient } },
		});
		env.fake.failNext("salesInvoices.create", new TypeError("fetch failed"));
		const subscription = await subscribe(env);
		await settle();
		expect(env.fake.salesInvoices.size).toBe(0);
		// Many ended checkouts of the same reference.
		for (let i = 0; i < 150; i++) {
			await env.context.adapter.create({
				model: "subscription",
				data: {
					referenceId: subscription.referenceId,
					customerType: "user",
					plan: "starter",
					status: "incomplete_expired",
					cancelAtPeriodEnd: false,
				},
			});
		}
		const adapter = env.context.adapter as any;
		const original = adapter.findMany.bind(adapter);
		let longest = 0;
		adapter.findMany = async (args: any) => {
			for (const clause of args.where ?? []) {
				if (clause.operator === "in" && Array.isArray(clause.value)) {
					longest = Math.max(longest, clause.value.length);
				}
			}
			return original(args);
		};
		const result = await syncMollieSubscriptions(env.auth as never, {
			referenceId: subscription.referenceId,
		});
		adapter.findMany = original;
		expect(result.invoicesCreated).toBe(1);
		expect(longest).toBeLessThanOrEqual(100);
	});
});
