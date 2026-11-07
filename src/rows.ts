import type { GenericEndpointContext as Ctx, Where } from "better-auth";
import type { SubscriptionLock } from "./lock";
import { LockLostError } from "./operations";
import { DEFAULT_GRACE_PERIOD_DAYS } from "./status";
import type {
	CustomerType,
	MollieOptions,
	MolliePaymentRecord,
	MolliePlan,
	PaymentOutcome,
	Subscription,
	SubscriptionStatus,
} from "./types";

/**
 * Reading and writing the `subscription` and `molliePayment` rows: guarded
 * updates, payment outcomes, and the small facts other modules derive from a
 * row. Nothing here talks to Mollie.
 */

/** Rows are read in pages of this size. */
export const PAGE_SIZE = 100;

/** The row's `periodEnd` as a `Date` (adapters may hand back strings). */
export function periodEndOf(subscription: Pick<Subscription, "periodEnd">): Date | null {
	return subscription.periodEnd ? new Date(subscription.periodEnd) : null;
}

export function gracePeriodDays(options: MollieOptions): number {
	return options.subscription?.enabled
		? (options.subscription.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS)
		: DEFAULT_GRACE_PERIOD_DAYS;
}

export async function findSubscription(ctx: Ctx, where: Where[]): Promise<Subscription | null> {
	return ctx.context.adapter.findOne<Subscription>({ model: "subscription", where });
}

export async function reload(ctx: Ctx, id: string): Promise<Subscription | null> {
	return findSubscription(ctx, [{ field: "id", value: id }]);
}

/**
 * Atomic, guarded update: only applies while the row's status is one of
 * `from` (and any extra conditions hold). Returns the updated row or `null`.
 *
 * `lock` makes the update apply only while that subscription lock is held.
 * `mollieSync` marks a change Mollie has to follow (plan, mandate,
 * cancellation, …): the row keeps `mollieSyncNeeded` until `reconcileRemote`
 * has brought Mollie in line, so a failed attempt is retried by the next
 * webhook or sync instead of waiting for the next payment date.
 */
export async function guardedUpdate(
	ctx: Ctx,
	id: string,
	from: readonly SubscriptionStatus[],
	set: Partial<Subscription>,
	extra: Where[] = [],
	options: { mollieSync?: boolean; lock?: SubscriptionLock | undefined } = {},
): Promise<Subscription | null> {
	return ctx.context.adapter.incrementOne<Subscription>({
		model: "subscription",
		where: [
			{ field: "id", value: id },
			{ field: "status", operator: "in", value: [...from] },
			...extra,
			// Under a lock: only while its lease holds (a stalled holder cannot write).
			...(options.lock ? options.lock.held() : []),
		],
		increment: options.mollieSync ? { mollieSyncRevision: 1 } : {},
		set: {
			...set,
			...(options.mollieSync ? { mollieSyncNeeded: true } : {}),
			updatedAt: new Date(),
		},
	});
}

/** Flags the row for another reconcile (e.g. one that had to be postponed). */
export async function flagMollieSync(ctx: Ctx, id: string, lock: SubscriptionLock): Promise<void> {
	await ctx.context.adapter.incrementOne<Subscription>({
		model: "subscription",
		where: [{ field: "id", value: id }, ...lock.held()],
		increment: {},
		set: { mollieSyncNeeded: true },
	});
}

/**
 * Clears `mollieSyncNeeded` after Mollie was brought in line with `seen`,
 * unless the row changed again since (its revision moved on).
 */
export async function markMollieSynced(
	ctx: Ctx,
	seen: Subscription,
	result: Subscription,
	lock: SubscriptionLock,
): Promise<Subscription> {
	if (!seen.mollieSyncNeeded) return result;
	const cleared = await ctx.context.adapter.incrementOne<Subscription>({
		model: "subscription",
		where: [
			{ field: "id", value: seen.id },
			{ field: "mollieSyncRevision", value: seen.mollieSyncRevision ?? 0 },
			...lock.held(),
		],
		increment: {},
		set: { mollieSyncNeeded: false },
	});
	return cleared ?? result;
}

export async function findPaymentRecord(
	ctx: Ctx,
	molliePaymentId: string,
): Promise<MolliePaymentRecord | null> {
	return ctx.context.adapter.findOne<MolliePaymentRecord>({
		model: "molliePayment",
		where: [{ field: "molliePaymentId", value: molliePaymentId }],
	});
}

/** Moves a payment's outcome `from → to` atomically; `null` if it was not in `from`. */
export async function setOutcome(
	ctx: Ctx,
	molliePaymentId: string,
	from: readonly PaymentOutcome[],
	to: PaymentOutcome,
	claim?: number,
	extra: Partial<Pick<MolliePaymentRecord, "paidThrough">> = {},
): Promise<MolliePaymentRecord | null> {
	return ctx.context.adapter.incrementOne<MolliePaymentRecord>({
		model: "molliePayment",
		where: [
			{ field: "molliePaymentId", value: molliePaymentId },
			{ field: "outcome", operator: "in", value: [...from] },
			// Only while no newer lock holder has claimed the payment.
			...(claim === undefined ? [] : [{ field: "claimSerial", value: claim }]),
		],
		increment: {},
		set: { ...extra, outcome: to },
	});
}

/**
 * Claims a payment for the holder of `lock` before it reads the payment's
 * outcome and decides on it. Lock serials only grow, so once a newer holder
 * (one that took over an expired lease) has claimed the payment, the older
 * holder's outcome writes no longer apply: deciding on a payment and
 * recording that decision cannot be split across two holders.
 */
export async function claimPayment(
	ctx: Ctx,
	molliePaymentId: string,
	lock: SubscriptionLock,
): Promise<MolliePaymentRecord> {
	const claim = (unclaimed: Where) =>
		ctx.context.adapter.incrementOne<MolliePaymentRecord>({
			model: "molliePayment",
			where: [{ field: "molliePaymentId", value: molliePaymentId }, unclaimed],
			increment: {},
			set: { claimSerial: lock.serial },
		});
	const claimed =
		(await claim({ field: "claimSerial", operator: "lte", value: lock.serial })) ??
		// A record from before `claimSerial` existed (missing or NULL).
		(await claim({ field: "claimSerial", value: null }));
	if (!claimed) throw new LockLostError(`payment:${molliePaymentId}`);
	return claimed;
}

/**
 * Before a payment replaces `appliedPaymentId`, the payment it replaces is
 * recorded as applied, so "applied" is never lost for any payment (even if
 * the process that applied it stopped before recording that).
 */
export async function settlePreviousPayment(
	ctx: Ctx,
	subscription: Subscription,
	payment: { id: string },
): Promise<void> {
	const previous = subscription.appliedPaymentId;
	if (previous && previous !== payment.id) {
		await setOutcome(ctx, previous, ["pending"], "applied");
	}
}

/**
 * Guard for an update that replaces `appliedPaymentId`: the marker is still
 * the one `settlePreviousPayment` recorded as applied.
 */
export function sameAppliedPayment(subscription: Subscription): Where[] {
	return subscription.appliedPaymentId
		? [{ field: "appliedPaymentId", value: subscription.appliedPaymentId }]
		: [];
}

/** Mollie wants descriptions unique per customer; the subscription id makes them so. */
export function subscriptionDescription(plan: MolliePlan, subscription: Subscription): string {
	return `${plan.description ?? `${plan.name} subscription`} · ${subscription.id}`;
}

/**
 * Whether a subscription bills a user or an organization (for the tax hook):
 * as chosen at checkout, or guessed from the reference for older rows.
 */
export async function customerTypeOf(ctx: Ctx, subscription: Subscription): Promise<CustomerType> {
	if (subscription.customerType === "user" || subscription.customerType === "organization") {
		return subscription.customerType;
	}
	const user = await ctx.context.adapter.findOne({
		model: "user",
		where: [{ field: "id", value: subscription.referenceId }],
	});
	return user ? "user" : "organization";
}

/**
 * Conditions for an update that undoes a pending cancellation (restore, a
 * plan change): only while the period has not ended, checked by the database
 * at the moment of the write.
 */
export function beforeCancellationTakesEffect(subscription: Subscription): Where[] {
	return subscription.cancelAtPeriodEnd
		? [{ field: "periodEnd", operator: "gt", value: new Date() }]
		: [];
}

/** How long a payment (or a request) waits for a subscription that is busy. */
export function lockWaitMs(options: MollieOptions): number {
	return options.lockWaitMs ?? 5000;
}

/**
 * Outcomes of a payment that is not paid whose consequence was not applied
 * yet (`applied`: a pro-rata charge a later upgrade recorded as applied).
 */
export const UNHANDLED: readonly PaymentOutcome[] = ["pending", "applied"];

export function isUnhandled(record: MolliePaymentRecord): boolean {
	return UNHANDLED.includes(record.outcome);
}
