import type { AuthContext } from "better-auth";
import { getTestInstance } from "better-auth/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	findByOperationKey,
	IN_FLIGHT_WINDOW_MS,
	OperationInProgressError,
	runOperation,
} from "../../src/operations";
import { mollieOperations } from "../../src/schema";
import type { MollieOperation } from "../../src/types";
import { mollieError } from "../helpers/fake-mollie";

async function setup() {
	const { auth } = await getTestInstance(
		{ plugins: [{ id: "operations-test", schema: mollieOperations }] },
		{ disableTestUser: true },
	);
	return (await auth.$context) as unknown as AuthContext;
}

function listOps(context: AuthContext) {
	return context.adapter.findMany<MollieOperation>({ model: "mollieOperation" });
}

describe("runOperation", () => {
	let context: AuthContext;
	beforeEach(async () => {
		context = await setup();
	});

	const base = {
		kind: "create_customer" as const,
		referenceId: "org_1",
		scope: "customer:organization:org_1",
		getId: (r: { id: string }) => r.id,
		recover: async () => null,
	};

	it("journals the call before executing it and passes the key to Mollie", async () => {
		const execute = vi.fn(async (key: string) => {
			const [op] = await listOps(context);
			expect(op).toMatchObject({ idempotencyKey: key, status: "pending" });
			return { id: "cst_1" };
		});
		const result = await runOperation(context, { ...base, reuseSucceeded: true, execute });
		expect(result).toMatchObject({ mollieId: "cst_1", replayed: false });
		expect(execute).toHaveBeenCalledWith("customer:organization:org_1#1");
		const [op] = await listOps(context);
		expect(op).toMatchObject({ status: "succeeded", mollieId: "cst_1", kind: "create_customer" });
	});

	it("reuses a succeeded one-shot operation instead of calling Mollie again", async () => {
		await runOperation(context, {
			...base,
			reuseSucceeded: true,
			execute: async () => ({ id: "cst_1" }),
		});
		const execute = vi.fn(async () => ({ id: "cst_2" }));
		const again = await runOperation(context, { ...base, reuseSucceeded: true, execute });
		expect(again).toMatchObject({ mollieId: "cst_1", replayed: true });
		expect(execute).not.toHaveBeenCalled();
	});

	it("starts a new numbered attempt when reuse is not wanted", async () => {
		await runOperation(context, {
			...base,
			reuseSucceeded: false,
			execute: async () => ({ id: "tr_1" }),
		});
		const second = await runOperation(context, {
			...base,
			reuseSucceeded: false,
			execute: async (key) => {
				expect(key).toBe("customer:organization:org_1#2");
				return { id: "tr_2" };
			},
		});
		expect(second.mollieId).toBe("tr_2");
	});

	it("leaves the row pending when the outcome is unknown, then recovers it by operationKey", async () => {
		await expect(
			runOperation(context, {
				...base,
				reuseSucceeded: true,
				execute: async () => {
					throw new TypeError("socket hang up");
				},
			}),
		).rejects.toThrow("socket hang up");
		expect((await listOps(context))[0]?.status).toBe("pending");

		const execute = vi.fn(async () => ({ id: "cst_duplicate" }));
		const recovered = await runOperation(context, {
			...base,
			reuseSucceeded: true,
			execute,
			recover: async (key) =>
				findByOperationKey([{ id: "cst_lost", metadata: { operationKey: key } }], key),
		});
		expect(recovered).toMatchObject({ mollieId: "cst_lost", replayed: true });
		expect(execute).not.toHaveBeenCalled();
		expect((await listOps(context))[0]).toMatchObject({
			status: "succeeded",
			mollieId: "cst_lost",
		});
	});

	it("refuses to run while a recent pending attempt may still be in flight", async () => {
		await runOperation(context, {
			...base,
			reuseSucceeded: true,
			execute: async () => {
				throw mollieError(503);
			},
		}).catch(() => {});
		await expect(
			runOperation(context, {
				...base,
				reuseSucceeded: true,
				execute: async () => ({ id: "cst_2" }),
			}),
		).rejects.toBeInstanceOf(OperationInProgressError);
	});

	it("writes off a stale pending attempt that never reached Mollie", async () => {
		await runOperation(context, {
			...base,
			reuseSucceeded: true,
			execute: async () => {
				throw mollieError(503);
			},
		}).catch(() => {});
		const later = new Date(Date.now() + IN_FLIGHT_WINDOW_MS + 1000);
		const result = await runOperation(context, {
			...base,
			reuseSucceeded: true,
			now: () => later,
			execute: async (key) => {
				expect(key).toBe("customer:organization:org_1#2");
				return { id: "cst_2" };
			},
		});
		expect(result.mollieId).toBe("cst_2");
		const statuses = (await listOps(context)).map((op) => op.status).sort();
		expect(statuses).toEqual(["failed", "succeeded"]);
	});

	it("marks definitive Mollie errors as failed so the next attempt runs immediately", async () => {
		await expect(
			runOperation(context, {
				...base,
				reuseSucceeded: true,
				execute: async () => {
					throw mollieError(422, "Invalid email");
				},
			}),
		).rejects.toThrow("Invalid email");
		expect((await listOps(context))[0]?.status).toBe("failed");
		const result = await runOperation(context, {
			...base,
			reuseSucceeded: true,
			execute: async () => ({ id: "cst_ok" }),
		});
		expect(result.mollieId).toBe("cst_ok");
	});

	it("lets only one of two concurrent attempts claim the journal row", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = runOperation(context, {
			...base,
			reuseSucceeded: true,
			execute: async () => {
				await gate;
				return { id: "cst_1" };
			},
		});
		await vi.waitFor(async () => expect(await listOps(context)).toHaveLength(1));
		const second = runOperation(context, {
			...base,
			reuseSucceeded: true,
			execute: async () => ({ id: "cst_2" }),
		});
		await expect(second).rejects.toBeInstanceOf(OperationInProgressError);
		release();
		await expect(first).resolves.toMatchObject({ mollieId: "cst_1" });
	});
});
