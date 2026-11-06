import { describe, expect, it, vi } from "vitest";
import { settle, setup } from "../helpers/setup";

describe("Mollie customers", () => {
	it("recovers a customer whose create response was lost, even behind 250+ newer customers", async () => {
		const env = await setup();
		env.fake.afterNextCreate("customers.create", () => {
			throw new TypeError("socket hang up");
		});
		await expect(env.checkout("starter")).rejects.toBeDefined();
		expect(env.fake.customers.size).toBe(1);

		// Lots of other customers are created at Mollie in the meantime.
		for (let i = 0; i < 300; i++) {
			await env.fake.client.customers.create({ entityCustomer: { name: `Other ${i}` } } as never);
		}

		await env.checkout("starter");
		expect(env.fake.customers.size).toBe(301);
		const [subscription] = await env.subscriptions();
		const lost = [...env.fake.customers.values()][0]!;
		expect(subscription?.mollieCustomerId).toBe(lost.id);
	});

	it("calls onCustomerCreate exactly once when upgrades race", async () => {
		const onCustomerCreate = vi.fn(async () => {});
		const env = await setup({ options: { onCustomerCreate } });
		const release = env.fake.hold("customers.create", "processing");
		const first = env.checkout("starter").catch((error: unknown) => error);
		await vi.waitFor(() => expect(env.fake.callsTo("customers.create")).toHaveLength(1));
		// The racing request is told to retry (409), not given a second customer.
		const second = env.checkout("starter").catch((error: unknown) => error);
		await settle();
		release();
		const outcomes = await Promise.all([first, second]);
		expect(outcomes.filter((o) => o instanceof Error)).toHaveLength(1);
		await env.checkout("starter");
		await settle();

		expect(env.fake.customers.size).toBe(1);
		expect(onCustomerCreate).toHaveBeenCalledTimes(1);
		expect(onCustomerCreate.mock.calls[0]).toMatchObject([
			{ mollieCustomer: { id: [...env.fake.customers.keys()][0] } },
			expect.anything(),
		]);
	});

	it("stores mollieCustomerId on the user and reuses the customer", async () => {
		const env = await setup();
		await env.checkout("starter");
		await env.checkout("business");
		expect(env.fake.customers.size).toBe(1);
		expect(env.fake.callsTo("customers.create")).toHaveLength(1);
	});
});
