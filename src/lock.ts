import type { GenericEndpointContext, Where } from "better-auth";
import { type Fence, LOCK_LEASE_MS, LockLostError, OperationInProgressError } from "./operations";
import type { Subscription } from "./types";

/**
 * A lease on one subscription row, stored on the row itself
 * (`lockToken`, `lockedUntil`).
 *
 * Everything that changes a subscription based on what it read (payments,
 * plan changes, cancel, restore, reconciling Mollie) holds it, so those
 * decisions are serialized. Because the lease lives on the row, a write can
 * require it atomically: `held()` adds "the lease is still mine and has not
 * expired" to the update's conditions, so a holder that stalled past its lease
 * can never write, whether or not someone else took over.
 */
export type SubscriptionLock = {
	subscriptionId: string;
	/** Renews the lease; throws `LockLostError` once it expired or was taken over. */
	fence: Fence;
	/** Conditions that make an update of the row apply only while the lease is held. */
	held: () => Where[];
	/**
	 * Increases with every acquisition of this subscription's lock: a fencing
	 * token for rows other than the subscription (see `claimPayment`).
	 */
	serial: number;
};

const RETRY_MS = 100;

export async function withSubscriptionLock<T>(
	ctx: GenericEndpointContext,
	subscriptionId: string,
	fn: (lock: SubscriptionLock) => Promise<T>,
	options: { waitMs?: number } = {},
): Promise<T> {
	const { adapter } = ctx.context;
	const token = globalThis.crypto.randomUUID();
	const key = `lock:subscription:${subscriptionId}`;
	const claim = async (free: Where) =>
		adapter.incrementOne<Subscription>({
			model: "subscription",
			where: [{ field: "id", value: subscriptionId }, free],
			increment: { lockSerial: 1 },
			set: { lockToken: token, lockedUntil: new Date(Date.now() + LOCK_LEASE_MS) },
		});
	// Counted in tries, not by the clock (which may not move, e.g. in tests).
	const tries = Math.ceil((options.waitMs ?? 0) / RETRY_MS);
	let serial = 0;
	for (let attempt = 0; ; attempt++) {
		const claimed =
			(await claim({ field: "lockedUntil", operator: "lt", value: new Date() })) ??
			(await claim({ field: "lockedUntil", value: null }));
		if (claimed) {
			serial = await serialOf(claimed);
			break;
		}
		if (attempt >= tries) throw new OperationInProgressError(key);
		await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
	}

	/** Rows from before `lockSerial` existed may hold `NULL` (and `NULL + 1` stays `NULL`). */
	async function serialOf(claimed: Subscription): Promise<number> {
		if (typeof claimed.lockSerial === "number") return claimed.lockSerial;
		const started = await adapter.incrementOne<Subscription>({
			model: "subscription",
			where: [
				{ field: "id", value: subscriptionId },
				{ field: "lockToken", value: token },
				{ field: "lockSerial", value: null },
			],
			increment: {},
			set: { lockSerial: 1 },
		});
		if (!started) throw new LockLostError(key);
		return 1;
	}

	const held = (): Where[] => [
		{ field: "lockToken", value: token },
		{ field: "lockedUntil", operator: "gte", value: new Date() },
	];
	const fence: Fence = async () => {
		const renewed = await adapter.incrementOne<Subscription>({
			model: "subscription",
			where: [{ field: "id", value: subscriptionId }, ...held()],
			increment: {},
			set: { lockedUntil: new Date(Date.now() + LOCK_LEASE_MS) },
		});
		if (!renewed) throw new LockLostError(key);
	};
	try {
		return await fn({ subscriptionId, fence, held, serial });
	} finally {
		await adapter
			.incrementOne<Subscription>({
				model: "subscription",
				where: [
					{ field: "id", value: subscriptionId },
					{ field: "lockToken", value: token },
				],
				increment: {},
				// NULL means no lease, and avoids MySQL TIMESTAMP rejecting the Unix epoch.
				set: { lockedUntil: null },
			})
			.catch(() => null);
	}
}
