import { describe, expect, it } from "vitest";
import { mollie } from "../../src";
import { createFakeMollie } from "../helpers/fake-mollie";
import { PLANS, setup } from "../helpers/setup";

async function orgSetup() {
	const env = await setup({ organization: true });
	const createOrg = async (name: string) =>
		(await env.api.createOrganization({
			body: { name, slug: name.toLowerCase().replace(/\s+/g, "-") },
			headers: env.headers,
		})) as { id: string; name: string };
	return { ...env, createOrg };
}

describe("organization billing (the default customerType)", () => {
	it("refuses to start a subscription without an organization instead of billing the user", async () => {
		const env = await orgSetup();
		await expect(env.checkout("starter")).rejects.toMatchObject({
			body: { code: "ORGANIZATION_REFERENCE_ID_REQUIRED" },
		});
		expect(env.fake.customers.size).toBe(0);
	});

	it("bills the active organization and asks authorizeReference first", async () => {
		const env = await orgSetup();
		const org = await env.createOrg("Acme Inc");
		const { payment } = await env.checkout("starter");

		expect(env.authorizeReference).toHaveBeenCalledWith(
			expect.objectContaining({ referenceId: org.id, action: "upgrade-subscription" }),
			expect.anything(),
		);
		const [subscription] = await env.subscriptions();
		expect(subscription?.referenceId).toBe(org.id);
		const customer = env.fake.customers.get(payment.customerId!);
		expect(customer).toMatchObject({
			name: "Acme Inc",
			metadata: { organizationId: org.id, customerType: "organization" },
		});
		const stored = await env.context.adapter.findOne<{ mollieCustomerId: string }>({
			model: "organization",
			where: [{ field: "id", value: org.id }],
		});
		expect(stored?.mollieCustomerId).toBe(customer!.id);
	});

	it("bills an explicit referenceId only when authorizeReference allows it", async () => {
		const env = await orgSetup();
		await env.createOrg("Acme");
		const other = await env.createOrg("Other");
		env.authorizeReference.mockResolvedValueOnce(false);
		await expect(
			env.api.upgradeSubscription({
				body: { plan: "starter", referenceId: other.id },
				headers: env.headers,
			}),
		).rejects.toMatchObject({ body: { code: "UNAUTHORIZED" } });
		expect(env.authorizeReference).toHaveBeenLastCalledWith(
			expect.objectContaining({ referenceId: other.id }),
			expect.anything(),
		);
	});

	it("still allows personal billing when the request asks for it", async () => {
		const env = await orgSetup();
		await env.createOrg("Acme");
		await env.checkout("starter", { customerType: "user" });
		const [subscription] = await env.subscriptions();
		expect(subscription?.referenceId).toBe(env.user.id);
	});

	it("needs authorizeReference to bill another user", async () => {
		const env = await setup({ subscription: { authorizeReference: undefined } });
		await expect(
			env.api.upgradeSubscription({
				body: { plan: "starter", referenceId: "someone-else" },
				headers: env.headers,
			}),
		).rejects.toMatchObject({ body: { code: "REFERENCE_ID_NOT_ALLOWED" } });
	});

	it("lists subscriptions per organization", async () => {
		const env = await orgSetup();
		const org = await env.createOrg("Acme");
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);
		const list = await env.api.listActiveSubscriptions({ headers: env.headers });
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			referenceId: org.id,
			plan: "starter",
			limits: { projects: 3 },
		});
	});

	it("blocks deleting an organization whose subscription is still billed", async () => {
		const env = await orgSetup();
		const org = await env.createOrg("Acme");
		const { payment } = await env.checkout("starter");
		env.fake.completePayment(payment.id, "paid");
		await env.webhook(`id=${payment.id}`);

		await expect(
			env.api.deleteOrganization({ body: { organizationId: org.id }, headers: env.headers }),
		).rejects.toMatchObject({ body: { code: "ORGANIZATION_HAS_ACTIVE_SUBSCRIPTION" } });
		// Still there, and still the user's active organization.
		const session = await env.api.getSession({ headers: env.headers });
		expect(session?.session.activeOrganizationId).toBe(org.id);

		await env.api.cancelSubscription({ body: { returnUrl: "/account" }, headers: env.headers });
		await expect(
			env.api.deleteOrganization({ body: { organizationId: org.id }, headers: env.headers }),
		).resolves.toBeDefined();
	});
});

describe("plugin options", () => {
	it("requires authorizeReference for organization billing", () => {
		expect(() =>
			mollie({
				mollieClient: createFakeMollie().client,
				subscription: { enabled: true, plans: PLANS },
			}),
		).toThrow(/authorizeReference/);
	});

	it("accepts per-user billing without authorizeReference", () => {
		expect(() =>
			mollie({
				mollieClient: createFakeMollie().client,
				subscription: { enabled: true, plans: PLANS, customerType: "user" },
			}),
		).not.toThrow();
	});

	it("rejects invalid plans and amounts at startup", () => {
		const client = createFakeMollie().client;
		expect(() =>
			mollie({
				mollieClient: client,
				subscription: {
					enabled: true,
					customerType: "user",
					plans: [{ name: "pro", amount: "9.9", interval: "1 month" }],
				},
			}),
		).toThrow(/invalid amount/);
		expect(() =>
			mollie({
				mollieClient: client,
				subscription: {
					enabled: true,
					customerType: "user",
					plans: PLANS,
					verificationAmount: "2 cents",
				},
			}),
		).toThrow(/verificationAmount/);
	});
});
