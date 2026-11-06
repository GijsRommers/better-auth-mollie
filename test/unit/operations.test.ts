import type { AuthContext } from "better-auth";
import { getTestInstance } from "better-auth/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGateway, type MollieGateway } from "../../src/gateway";
import {
	findByOperationKey,
	OperationInProgressError,
	OperationSupersededError,
	REPLAY_WINDOW_MS,
	type RunOperationOptions,
	runOperation,
} from "../../src/operations";
import { mollieOperationSchema } from "../../src/schema";
import type { MollieOperation } from "../../src/types";
import { createFakeMollie, type FakeMollie, mollieError } from "../helpers/fake-mollie";

async function setup() {
	const { auth } = await getTestInstance(
		{ plugins: [{ id: "operations-test", schema: mollieOperationSchema }] },
		{ disableTestUser: true },
	);
	return (await auth.$context) as unknown as AuthContext;
}

function listOps(context: AuthContext) {
	return context.adapter.findMany<MollieOperation>({ model: "mollieOperation", limit: 1000 });
}

const minutes = (n: number) => n * 60 * 1000;
const later = (ms: number) => () => new Date(Date.now() + ms);

/**
 * A realistic operation: create a Mollie subscription. Parameters depend only
 * on the key, as the journal requires.
 */
let gateway: MollieGateway;

function createSubscriptionOperation(
	_fake: FakeMollie,
	customerId: string,
	overrides: Partial<RunOperationOptions<{ id: string }>> = {},
): RunOperationOptions<{ id: string }> {
	return {
		kind: "create_subscription",
		referenceId: "sub_local",
		scope: "activate:sub_local:tr_1",
		reuseSucceeded: true,
		execute: (idempotencyKey) =>
			gateway.createSubscription(
				customerId,
				{
					amount: { currency: "EUR", value: "9.95" },
					interval: "1 month",
					description: "Pro subscription · sub_local",
					metadata: { subscriptionId: "sub_local", operationKey: idempotencyKey },
				},
				idempotencyKey,
			),
		getId: (subscription) => subscription.id,
		recover: async (idempotencyKey) =>
			findByOperationKey(await gateway.listSubscriptions(customerId), idempotencyKey),
		compensate: async (mollieId) => {
			await gateway.cancelSubscription(customerId, mollieId, `compensate:${mollieId}`);
		},
		...overrides,
	};
}

describe("runOperation", () => {
	let context: AuthContext;
	let fake: FakeMollie;
	let customerId: string;

	beforeEach(async () => {
		context = await setup();
		fake = createFakeMollie();
		gateway = createGateway(fake.client);
		customerId = (await gateway.createCustomer({ name: "Acme" }, "customer:acme")).id;
	});

	it("journals the call before executing it and passes the key to Mollie", async () => {
		const operation = createSubscriptionOperation(fake, customerId);
		const execute = vi.fn(async (key: string) => {
			const [op] = await listOps(context);
			expect(op).toMatchObject({ idempotencyKey: key, status: "pending" });
			return operation.execute(key);
		});
		const result = await runOperation(context, { ...operation, execute });
		expect(result.replayed).toBe(false);
		expect(execute).toHaveBeenCalledWith("activate:sub_local:tr_1#1");
		const [call] = fake.callsTo("subscriptions.create");
		expect(call?.args[0]).toMatchObject({ idempotencyKey: "activate:sub_local:tr_1#1" });
		const [op] = await listOps(context);
		expect(op).toMatchObject({ status: "succeeded", mollieId: result.mollieId });
	});

	it("reuses a succeeded one-shot operation instead of calling Mollie again", async () => {
		const operation = createSubscriptionOperation(fake, customerId);
		const first = await runOperation(context, operation);
		const again = await runOperation(context, operation);
		expect(again).toMatchObject({ mollieId: first.mollieId, replayed: true });
		expect(fake.callsTo("subscriptions.create")).toHaveLength(1);
	});

	it("starts a new numbered attempt when reuse is not wanted", async () => {
		const operation = createSubscriptionOperation(fake, customerId, {
			reuseSucceeded: false,
			execute: (key) =>
				gateway.createPayment(
					{
						amount: { currency: "EUR", value: "0.02" },
						description: "verification",
						sequenceType: "first",
						customerId,
						metadata: { operationKey: key },
					},
					key,
				),
		});
		await runOperation(context, operation);
		const second = await runOperation(context, operation);
		expect(second.idempotencyKey).toBe("activate:sub_local:tr_1#2");
		expect(fake.payments.size).toBe(2);
	});

	it("recovers a lost response by operationKey instead of creating a duplicate", async () => {
		fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		const operation = createSubscriptionOperation(fake, customerId);
		await expect(runOperation(context, operation)).rejects.toThrow("socket hang up");
		expect((await listOps(context))[0]?.status).toBe("pending");

		const recovered = await runOperation(context, operation);
		expect(recovered.replayed).toBe(true);
		expect(fake.subscriptions.size).toBe(1);
		expect((await listOps(context))[0]).toMatchObject({
			status: "succeeded",
			mollieId: recovered.mollieId,
		});
	});

	it("re-sends a slow pending attempt with the same key, so it cannot duplicate", async () => {
		// Attempt A is journaled, then stalls before its request reaches Mollie.
		const release = fake.hold("subscriptions.create", "arrival");
		const operation = createSubscriptionOperation(fake, customerId);
		const attemptA = runOperation(context, operation);
		await vi.waitFor(async () => expect(await listOps(context)).toHaveLength(1));

		// B arrives minutes later, finds nothing at Mollie, and re-sends key #1.
		const attemptB = await runOperation(context, { ...operation, now: later(minutes(5)) });
		expect(attemptB.idempotencyKey).toBe("activate:sub_local:tr_1#1");

		// A's request finally arrives with the same key: Mollie replays B's result.
		release();
		const resultA = await attemptA;
		expect(resultA.mollieId).toBe(attemptB.mollieId);
		expect(fake.subscriptions.size).toBe(1);
		expect(await listOps(context)).toHaveLength(1);
	});

	it("reports an attempt Mollie is still processing as in progress", async () => {
		const release = fake.hold("subscriptions.create", "processing");
		const operation = createSubscriptionOperation(fake, customerId);
		const attemptA = runOperation(context, operation);
		await vi.waitFor(() => expect(fake.callsTo("subscriptions.create")).toHaveLength(1));

		await expect(runOperation(context, operation)).rejects.toBeInstanceOf(OperationInProgressError);
		expect((await listOps(context))[0]?.status).toBe("pending");

		release();
		await expect(attemptA).resolves.toMatchObject({ replayed: false });
		expect(fake.subscriptions.size).toBe(1);
	});

	it("compensates an attempt that completes after it was written off", async () => {
		const release = fake.hold("subscriptions.create", "arrival");
		const compensate = vi.fn(async (mollieId: string) => {
			await gateway.cancelSubscription(customerId, mollieId, `compensate:${mollieId}`);
		});
		// Per-attempt descriptions, so Mollie's description-uniqueness rule (see
		// the next test) does not reject the late duplicate first.
		const operation = createSubscriptionOperation(fake, customerId, {
			compensate,
			execute: (idempotencyKey) =>
				gateway.createSubscription(
					customerId,
					{
						amount: { currency: "EUR", value: "9.95" },
						interval: "1 month",
						description: `Pro subscription · ${idempotencyKey}`,
						metadata: { operationKey: idempotencyKey },
					},
					idempotencyKey,
				),
		});
		const attemptA = runOperation(context, operation);
		await vi.waitFor(async () => expect(await listOps(context)).toHaveLength(1));

		// Past Mollie's key retention nothing carries key #1, so B writes it off.
		const attemptB = await runOperation(context, {
			...operation,
			now: later(REPLAY_WINDOW_MS + minutes(1)),
		});
		expect(attemptB.idempotencyKey).toBe("activate:sub_local:tr_1#2");

		release();
		const error = await attemptA.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OperationSupersededError);
		expect(compensate).toHaveBeenCalledWith((error as OperationSupersededError).mollieId);
		expect(fake.activeSubscriptionsFor(customerId).map((s) => s.id)).toEqual([attemptB.mollieId]);
	});

	/** Pauses inside `recover` until released; resolves `paused` when reached. */
	function pausableRecover(
		recover: (key: string) => Promise<string | null>,
		pause: "before-lookup" | "after-lookup" = "before-lookup",
	) {
		let resume!: () => void;
		let reached!: () => void;
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const paused = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let first = true;
		return {
			paused,
			resume,
			recover: async (key: string) => {
				if (!first) return recover(key);
				first = false;
				const found = pause === "after-lookup" ? await recover(key) : undefined;
				reached();
				await gate;
				return pause === "after-lookup" ? (found ?? null) : recover(key);
			},
		};
	}

	/** Descriptions differ per attempt, so Mollie's uniqueness rule cannot help. */
	function unprotectedOperation(overrides: Partial<RunOperationOptions<{ id: string }>> = {}) {
		return createSubscriptionOperation(fake, customerId, {
			execute: (idempotencyKey) =>
				gateway.createSubscription(
					customerId,
					{
						amount: { currency: "EUR", value: "9.95" },
						interval: "1 month",
						description: `Pro subscription · ${idempotencyKey}`,
						metadata: { operationKey: idempotencyKey },
					},
					idempotencyKey,
				),
			...overrides,
		});
	}

	it("uses a stale attempt's result when it finishes while being written off", async () => {
		const release = fake.hold("subscriptions.create", "arrival");
		const operation = unprotectedOperation();
		const attemptA = runOperation(context, operation);
		await vi.waitFor(async () => expect(await listOps(context)).toHaveLength(1));

		// B finds nothing for key #1 (A has not reached Mollie yet), then pauses.
		const lookup = pausableRecover(async (key) => {
			const found = await operation.recover(key);
			expect(found).toBeNull();
			return found;
		}, "after-lookup");
		const attemptB = runOperation(context, {
			...operation,
			recover: lookup.recover,
			now: later(REPLAY_WINDOW_MS + minutes(1)),
		});
		await lookup.paused;

		// Meanwhile A completes and records success.
		release();
		const resultA = await attemptA;

		// B's write-off now loses; it must adopt A's result, not start #2.
		lookup.resume();
		const resultB = await attemptB;
		expect(resultB).toMatchObject({ mollieId: resultA.mollieId, replayed: true });
		expect(fake.subscriptions.size).toBe(1);
		expect(await listOps(context)).toHaveLength(1);
	});

	it("never hands out a recovered resource whose attempt was written off", async () => {
		const releaseA = fake.hold("subscriptions.create", "arrival");
		const operation = unprotectedOperation();
		const attemptA = runOperation(context, operation);
		await vi.waitFor(async () => expect(await listOps(context)).toHaveLength(1));

		// B loads A as pending; its lookup stalls.
		const lookup = pausableRecover(operation.recover);
		const attemptB = runOperation(context, {
			...operation,
			recover: lookup.recover,
			now: later(REPLAY_WINDOW_MS + minutes(1)),
		});
		await lookup.paused;

		// C writes A off and creates the replacement attempt.
		const resultC = await runOperation(context, {
			...operation,
			now: later(REPLAY_WINDOW_MS + minutes(1)),
		});
		expect(resultC.idempotencyKey).toBe("activate:sub_local:tr_1#2");

		// A's request lands late; A sees it was written off and compensates.
		releaseA();
		await expect(attemptA).rejects.toBeInstanceOf(OperationSupersededError);

		// B's lookup now finds A's compensated subscription, but must return C's.
		lookup.resume();
		const resultB = await attemptB;
		expect(resultB.mollieId).toBe(resultC.mollieId);
		expect(fake.activeSubscriptionsFor(customerId).map((s) => s.id)).toEqual([resultC.mollieId]);
	});

	it("relies on Mollie's unique subscription description as a second safety net", async () => {
		const release = fake.hold("subscriptions.create", "arrival");
		const operation = createSubscriptionOperation(fake, customerId);
		const attemptA = runOperation(context, operation);
		await vi.waitFor(async () => expect(await listOps(context)).toHaveLength(1));
		await runOperation(context, { ...operation, now: later(REPLAY_WINDOW_MS + minutes(1)) });

		release();
		await expect(attemptA).rejects.toMatchObject({ statusCode: 422 });
		expect(fake.activeSubscriptionsFor(customerId)).toHaveLength(1);
	});

	it("keeps the attempt pending when Mollie rejects a reused key with different parameters", async () => {
		fake.afterNextCreate("subscriptions.create", () => {
			throw new TypeError("socket hang up");
		});
		const operation = createSubscriptionOperation(fake, customerId, {
			recover: async () => null, // a lookup that misses the created resource
		});
		await expect(runOperation(context, operation)).rejects.toThrow("socket hang up");

		const changed = createSubscriptionOperation(fake, customerId, {
			recover: async () => null,
			execute: (idempotencyKey) =>
				gateway.createSubscription(
					customerId,
					{
						amount: { currency: "EUR", value: "19.95" },
						interval: "1 month",
						description: "Business subscription",
						metadata: { operationKey: idempotencyKey },
					},
					idempotencyKey,
				),
		});
		await expect(runOperation(context, changed)).rejects.toMatchObject({ statusCode: 400 });
		// A 400 here does not prove the first request failed: stay pending.
		expect((await listOps(context))[0]?.status).toBe("pending");

		// A working lookup later resolves it to the subscription that exists.
		const resolved = await runOperation(context, createSubscriptionOperation(fake, customerId));
		expect(resolved.replayed).toBe(true);
		expect(fake.subscriptions.size).toBe(1);
	});

	it("marks requests Mollie rejected as failed so the next attempt runs immediately", async () => {
		fake.failNext("subscriptions.create", mollieError(422, "The mandate is invalid"));
		const operation = createSubscriptionOperation(fake, customerId);
		await expect(runOperation(context, operation)).rejects.toThrow("The mandate is invalid");
		expect((await listOps(context))[0]?.status).toBe("failed");

		const retry = await runOperation(context, operation);
		expect(retry.idempotencyKey).toBe("activate:sub_local:tr_1#2");
	});

	it("numbers attempts past the adapter's default page size", async () => {
		const scope = "first-payment:sub_local";
		for (let n = 1; n <= 105; n++) {
			await context.adapter.create({
				model: "mollieOperation",
				data: {
					idempotencyKey: `${scope}#${n}`,
					kind: "create_first_payment",
					referenceId: "sub_local",
					status: "failed",
					createdAt: new Date(),
				},
			});
		}
		const execute = vi.fn(async (key: string) => ({ id: `tr_${key}` }));
		const result = await runOperation(context, {
			kind: "create_first_payment",
			referenceId: "sub_local",
			scope,
			reuseSucceeded: false,
			execute,
			getId: (r) => r.id,
			recover: async () => null,
		});
		expect(execute).toHaveBeenCalledWith(`${scope}#106`);
		expect(result.idempotencyKey).toBe(`${scope}#106`);
	});

	it("finds a pending attempt among many rows of other scopes", async () => {
		for (let n = 1; n <= 150; n++) {
			await context.adapter.create({
				model: "mollieOperation",
				data: {
					idempotencyKey: `cancel:sub_old_${n}#1`,
					kind: "cancel_subscription",
					referenceId: "org_1",
					status: "succeeded",
					mollieId: `sub_old_${n}`,
					createdAt: new Date(),
				},
			});
		}
		await context.adapter.create({
			model: "mollieOperation",
			data: {
				idempotencyKey: "cancel:sub_current#1",
				kind: "cancel_subscription",
				referenceId: "org_1",
				status: "pending",
				createdAt: new Date(),
			},
		});
		const execute = vi.fn(async () => ({ id: "sub_new" }));
		const result = await runOperation(context, {
			kind: "cancel_subscription",
			referenceId: "org_1",
			scope: "cancel:sub_current",
			reuseSucceeded: true,
			execute,
			getId: (r) => r.id,
			recover: async (key) => (key === "cancel:sub_current#1" ? "sub_current" : null),
		});
		expect(result).toMatchObject({ mollieId: "sub_current", replayed: true });
		expect(execute).not.toHaveBeenCalled();
	});
});
