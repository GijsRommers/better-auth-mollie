import type { GenericEndpointContext as Ctx, Where } from "better-auth";
import { dispatchEvents } from "./events";
import { type Fence, OperationInProgressError, withLock } from "./operations";
import { lockWaitMs, PAGE_SIZE, periodEndOf, reload, sameDate } from "./rows";
import { BILLING_STATUSES } from "./status";
import type { CustomerType, MollieOptions, Subscription } from "./types";
import { getPlanByName } from "./utils";

/**
 * One billing subscription per identity (a reference id and the customer
 * type it is billed as): the lock that serializes starting or restoring one,
 * and the check that no other row still covers the identity.
 */

/**
 * Whether a subscription row bills this identity: the reference id and the
 * customer type (a user and an organization can have the same id string,
 * e.g. with custom references). Rows from before `customerType` existed match
 * any type.
 */
export function billsIdentity(
	subscription: Subscription,
	identity: { referenceId: string; customerType: CustomerType | null },
): boolean {
	return (
		subscription.referenceId === identity.referenceId &&
		(!identity.customerType ||
			!subscription.customerType ||
			subscription.customerType === identity.customerType)
	);
}

/**
 * Runs `fn` under a lock per billing identity, which serializes creating a
 * pending subscription row and activating one: so an identity never gets two.
 * Acquisition is retried for up to `lockWaitMs`. Lock order: a subscription
 * lock (if any) is taken before this one, never after.
 */
export async function withReferenceLock<T>(
	ctx: Ctx,
	options: MollieOptions,
	identity: { referenceId: string; customerType: CustomerType | null },
	fn: (fence: Fence) => Promise<T>,
): Promise<T> {
	// Per reference, not per type: rows without a customer type match either
	// identity, so both must be excluded by the same lock.
	const key = `lock:reference:${identity.referenceId}`;
	for (let attempt = 0; ; attempt++) {
		let entered = false;
		try {
			return await withLock(ctx.context, { key, referenceId: identity.referenceId }, (fence) => {
				entered = true;
				return fn(fence);
			});
		} catch (error) {
			const busy = !entered && error instanceof OperationInProgressError;
			if (!busy || attempt * 100 >= lockWaitMs(options)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}

/**
 * `covered`: another subscription still covers the identity; `free`: none
 * does; `busy`: one may (or another pending row may be activating), and is
 * being changed right now: try again shortly.
 */
export type Coverage = "covered" | "free" | "busy";

/**
 * Whether a subscription other than `exceptId` still covers this identity,
 * over all of the reference's rows (paged by id, so rows that change
 * meanwhile are never skipped). A row with no customer type stands for either
 * identity, on both sides. Call it under `withReferenceLock`; it also makes
 * sure nothing decided earlier can still change that answer:
 *
 * - another subscription whose cancellation date has passed is ended here;
 * - another pending row is fenced out (so an activation of it that stalled
 *   cannot complete afterwards).
 *
 * Both happen atomically and only while nobody holds that row's lock, and
 * replace its lock token and serial: whoever was about to write it (a
 * restore, an activation) based on an older decision no longer matches.
 * `subscription.canceled` events of rows ended here are dispatched right away.
 */
export async function coverage(
	ctx: Ctx,
	options: MollieOptions,
	identity: { referenceId: string; customerType: CustomerType | null },
	exceptId: string,
	now: Date,
): Promise<Coverage> {
	let busy = false;
	let cursor: string | null = null;
	for (;;) {
		const page: Subscription[] = await ctx.context.adapter.findMany<Subscription>({
			model: "subscription",
			where: [
				{ field: "referenceId", value: identity.referenceId },
				{ field: "status", operator: "in", value: [...BILLING_STATUSES, "incomplete"] },
				...(cursor ? [{ field: "id", operator: "gt" as const, value: cursor }] : []),
			],
			sortBy: { field: "id", direction: "asc" },
			limit: PAGE_SIZE,
		});
		for (const other of page) {
			if (other.id === exceptId || !billsIdentity(other, identity)) continue;
			if (other.status === "incomplete") {
				if (!(await fenceOut(ctx, other, now))) busy = true;
				continue;
			}
			if (stillCovers(other, now)) return "covered";
			const ended = await endDueCancellation(ctx, options, other, now);
			if (ended === "covers") return "covered";
			if (ended === "busy") busy = true;
		}
		if (page.length < PAGE_SIZE) break;
		cursor = (page[page.length - 1] as Subscription).id;
	}
	return busy ? "busy" : "free";
}

/** Atomically replaces an unlocked row's lock token and serial; false if it is locked. */
async function fenceOut(ctx: Ctx, subscription: Subscription, now: Date): Promise<boolean> {
	const rotate = (unlocked: Where) =>
		ctx.context.adapter.incrementOne<Subscription>({
			model: "subscription",
			where: [{ field: "id", value: subscription.id }, unlocked],
			increment: { lockSerial: 1 },
			set: { lockToken: globalThis.crypto.randomUUID(), lockedUntil: new Date(0) },
		});
	const rotated =
		(await rotate({ field: "lockedUntil", operator: "lt", value: now })) ??
		(await rotate({ field: "lockedUntil", value: null }));
	return rotated !== null;
}

/**
 * Ends a subscription whose cancellation date has passed, unless someone
 * holds its lock (`busy`) or it was restored meanwhile (`covers`).
 */
async function endDueCancellation(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	now: Date,
): Promise<"ended" | "busy" | "covers"> {
	// Only called for a cancellation whose date has passed (see `stillCovers`).
	const periodEnd = periodEndOf(subscription);
	if (!periodEnd) return "covers";
	const end = (unlocked: Where) =>
		ctx.context.adapter.incrementOne<Subscription>({
			model: "subscription",
			where: [
				{ field: "id", value: subscription.id },
				{ field: "status", operator: "in", value: [...BILLING_STATUSES] },
				{ field: "cancelAtPeriodEnd", value: true },
				...sameDate("periodEnd", periodEnd),
				unlocked,
			],
			increment: { mollieSyncRevision: 1, lockSerial: 1 },
			set: {
				status: "canceled",
				pendingPlan: null,
				mollieSyncNeeded: true,
				lockToken: globalThis.crypto.randomUUID(),
				lockedUntil: new Date(0),
				updatedAt: new Date(),
			},
		});
	const ended =
		(await end({ field: "lockedUntil", operator: "lt", value: now })) ??
		(await end({ field: "lockedUntil", value: null }));
	if (ended) {
		const plan = await getPlanByName(options, ended.plan).catch(() => undefined);
		dispatchEvents(ctx, options, [
			{ type: "subscription.canceled", subscription: ended, plan, reason: "period_ended" },
		]);
		return "ended";
	}
	const current = await reload(ctx, subscription.id);
	if (!current || !BILLING_STATUSES.includes(current.status)) return "ended";
	return stillCovers(current, now) ? "covers" : "busy";
}

/** Whether another subscription still covers this identity, by its state and the clock. */
function stillCovers(other: Subscription, now: Date): boolean {
	if (!BILLING_STATUSES.includes(other.status)) return false;
	const periodEnd = periodEndOf(other);
	// A cancellation whose date has passed ends it, even before the sync records that.
	return !(other.cancelAtPeriodEnd && periodEnd && periodEnd <= now);
}
