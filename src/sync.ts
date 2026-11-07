import type { GenericEndpointContext as Ctx, Where } from "better-auth";
import {
	expireCheckout,
	paymentHookData,
	processPayment,
	reconcileRemote,
	recordPayment,
	type Settlement,
	settleCustomerCharges,
	settleRecentCharges,
} from "./billing";
import type { BillingEvent } from "./events";
import { gatewayFor, type MolliePayment, metadataOf } from "./gateway";
import { type SubscriptionLock, withSubscriptionLock } from "./lock";
import {
	LOCK_LEASE_MS,
	mollieKey,
	OperationInProgressError,
	pendingOperations,
	REPLAY_WINDOW_MS,
	resolveOperation,
} from "./operations";
import { cancelMollieSubscription, findRemote, reconcileMollieSubscription } from "./remote";
import {
	findPaymentRecord,
	gracePeriodDays,
	guardedUpdate,
	PAGE_SIZE,
	periodEndOf,
	reload,
	UNHANDLED,
} from "./rows";
import { catchUpSalesInvoices } from "./sales-invoices";
import { BILLING_STATUSES, SYNCABLE_STATUSES } from "./status";
import { toCents } from "./tax";
import type { MollieOptions, MolliePaymentRecord, Subscription } from "./types";
import { addDays, DAY_MS, errorMessage, getPlanByName } from "./utils";

/**
 * What the clock and the cron do: transitions that depend only on time, and
 * `syncMollieSubscriptions`, which brings every subscription that may still
 * change up to date with Mollie.
 */

/**
 * Transitions that only depend on the clock:
 * - pending cancellation past `periodEnd` → `canceled`
 * - scheduled plan change at `periodEnd` → `plan = pendingPlan`
 * - `past_due` past `periodEnd + gracePeriodDays` → `unpaid`
 */
export async function applyTimeTransitions(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	now: Date,
	lock?: SubscriptionLock,
	delinquency = true,
): Promise<{ subscription: Subscription; events: BillingEvent[] }> {
	const periodEnd = periodEndOf(subscription);
	if (!periodEnd || !BILLING_STATUSES.includes(subscription.status)) {
		return { subscription, events: [] };
	}
	if (subscription.cancelAtPeriodEnd && now >= periodEnd) {
		// Flagged, so the sync makes sure nothing at Mollie bills it any more.
		const canceled = await guardedUpdate(
			ctx,
			subscription.id,
			BILLING_STATUSES,
			{ status: "canceled", pendingPlan: null },
			// Only the cancellation that was read: not one restored meanwhile.
			[
				{ field: "cancelAtPeriodEnd", value: true },
				{ field: "periodEnd", value: periodEnd },
			],
			{ mollieSync: true, lock },
		);
		if (!canceled) return { subscription, events: [] };
		const plan = await getPlanByName(options, canceled.plan);
		return {
			subscription: canceled,
			events: [
				{ type: "subscription.canceled", subscription: canceled, plan, reason: "period_ended" },
			],
		};
	}
	if (subscription.pendingPlan && now >= periodEnd) {
		// A scheduled plan change takes effect at the end of the period, even if
		// the first payment for the new plan is still on its way.
		const switched = await guardedUpdate(
			ctx,
			subscription.id,
			BILLING_STATUSES,
			{ plan: subscription.pendingPlan, pendingPlan: null },
			[
				{ field: "pendingPlan", value: subscription.pendingPlan },
				{ field: "periodEnd", value: periodEnd },
			],
			{ lock },
		);
		if (switched) return applyTimeTransitions(ctx, options, switched, now, lock, delinquency);
	}
	if (
		delinquency &&
		subscription.status === "past_due" &&
		now >= addDays(periodEnd, gracePeriodDays(options))
	) {
		const unpaid = await guardedUpdate(
			ctx,
			subscription.id,
			["past_due"],
			{ status: "unpaid" },
			[{ field: "periodEnd", value: periodEnd }],
			{ lock },
		);
		return { subscription: unpaid ?? subscription, events: [] };
	}
	return { subscription, events: [] };
}

/**
 * Applies due clock transitions (end at period end, scheduled plan change)
 * under the subscription's lock on a fresh read, for requests that need the
 * current state. Being past due long enough (`unpaid`) is left to the sync,
 * which first makes sure no paid charge is still unprocessed. Returns the
 * row unchanged if nothing is due, or if the subscription stays busy for
 * longer than `waitMs`.
 */
export async function applyDueTransitions(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	now: Date,
	waitMs: number,
): Promise<{ subscription: Subscription; events: BillingEvent[] }> {
	const periodEnd = periodEndOf(subscription);
	const due =
		!!periodEnd &&
		now >= periodEnd &&
		BILLING_STATUSES.includes(subscription.status) &&
		(!!subscription.cancelAtPeriodEnd || !!subscription.pendingPlan);
	if (!due) return { subscription, events: [] };
	try {
		return await withSubscriptionLock(
			ctx,
			subscription.id,
			async (lock) => {
				const fresh = (await reload(ctx, subscription.id)) ?? subscription;
				return applyTimeTransitions(ctx, options, fresh, now, lock, false);
			},
			{ waitMs },
		);
	} catch (error) {
		if (error instanceof OperationInProgressError) return { subscription, events: [] };
		throw error;
	}
}

/** Mollie subscriptions younger than this may still be adopted by a running change. */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Safety net: cancels running Mollie subscriptions created for this
 * subscription that it did not adopt (e.g. left by a crash between creating
 * a replacement and recording it). Runs before the next payment date, so an
 * orphan never charges.
 */
async function cancelOrphans(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	now: Date,
	lock: SubscriptionLock,
): Promise<void> {
	const customerId = subscription.mollieCustomerId;
	if (!customerId) return;
	for (const remote of await gatewayFor(options).listLiveCustomerSubscriptions(customerId)) {
		if (remote.id === subscription.mollieSubscriptionId) continue;
		if (metadataOf(remote).subscriptionId !== subscription.id) continue;
		if (now.getTime() - new Date(remote.createdAt).getTime() < ORPHAN_GRACE_MS) continue;
		ctx.context.logger.warn(
			`[mollie] Canceling orphaned Mollie subscription ${remote.id} of ${subscription.id}`,
		);
		await lock.fence();
		await cancelMollieSubscription(ctx, options, {
			...subscription,
			mollieSubscriptionId: remote.id,
		});
	}
}

const UNRESOLVED_PAYMENT_STATUSES = ["open", "pending", "authorized"] as const;

/**
 * Payment records that still need processing: not final yet (across all
 * subscriptions: only recurring charges), or paid without a settled outcome.
 */
async function outstandingPayments(
	ctx: Ctx,
	subscriptionId?: string,
): Promise<MolliePaymentRecord[]> {
	const scope: Where[] = subscriptionId ? [{ field: "subscriptionId", value: subscriptionId }] : [];
	const queries: Where[][] = [
		[
			...scope,
			{ field: "status", value: "paid" },
			{ field: "outcome", operator: "in", value: ["pending", "duplicate"] },
		],
		// Hooks still due (the delivery that recorded the change stopped).
		[...scope, { field: "hooksDue", value: true }],
		[...scope, { field: "chargebackDue", value: true }],
		// Not paid, consequence not applied yet (e.g. a failed renewal recorded
		// right before the process stopped). Across all subscriptions only
		// charges: failed checkouts matter for incomplete rows, synced anyway.
		[
			...scope,
			{ field: "status", operator: "in", value: ["failed", "expired", "canceled"] },
			{ field: "outcome", operator: "in", value: [...UNHANDLED] },
			...(subscriptionId ? [] : [{ field: "sequenceType", value: "recurring" }]),
		],
	];
	queries.unshift([
		...scope,
		{ field: "status", operator: "in", value: [...UNRESOLVED_PAYMENT_STATUSES] },
		// Across all subscriptions only charges (renewals, pro-rata), not
		// abandoned checkouts.
		...(subscriptionId ? [] : [{ field: "sequenceType", value: "recurring" }]),
	]);
	const found: MolliePaymentRecord[] = [];
	for (const where of queries) {
		for (let offset = 0; ; offset += PAGE_SIZE) {
			const page = await ctx.context.adapter.findMany<MolliePaymentRecord>({
				model: "molliePayment",
				where,
				sortBy: { field: "molliePaymentId", direction: "asc" },
				limit: PAGE_SIZE,
				offset,
			});
			found.push(...page);
			if (page.length < PAGE_SIZE) break;
		}
	}
	const seen = new Set<string>();
	return found.filter(
		(record) => !seen.has(record.molliePaymentId) && !!seen.add(record.molliePaymentId),
	);
}

/**
 * Whether the sync looks at Mollie for this subscription: around its next
 * payment date (from one day before `periodEnd`), while past due, once a day
 * while unpaid, or when a change still has to reach Mollie. Other
 * subscriptions are not fetched.
 */
function needsRemoteCheck(subscription: Subscription, now: Date): boolean {
	if (!BILLING_STATUSES.includes(subscription.status)) return false;
	if (subscription.mollieSyncNeeded) return true;
	const periodEnd = periodEndOf(subscription);
	if (subscription.status === "active" || subscription.status === "trialing") {
		return !(periodEnd && now.getTime() < periodEnd.getTime() - DAY_MS);
	}
	if (subscription.status === "past_due") return true;
	// Unpaid: its Mollie subscription keeps charging (the customer may still
	// pay), possibly for a long time. Once a day is enough for a fallback.
	const checkedAt = subscription.mollieCheckedAt;
	return !checkedAt || now.getTime() - new Date(checkedAt).getTime() >= DAY_MS;
}

/**
 * Brings one subscription up to date with Mollie and the clock, in two parts:
 *
 * 1. Without holding the subscription (each payment takes its lock briefly):
 *    payments that are outstanding locally are processed; and when Mollie is
 *    checked (see `needsRemoteCheck`), its subscription status is read and
 *    charges whose webhook never arrived are found and processed.
 * 2. Under the subscription's lock, on the row as it is now: clock-based
 *    transitions, Mollie's status, bringing Mollie in line (`reconcileRemote`)
 *    and stray Mollie subscriptions. Being past due (or unpaid) is only
 *    decided when part 1 established every charge: a renewal that was paid
 *    but could not be processed must never cost the customer access.
 *
 * Each step runs on its own: one that fails is reported and retried by the
 * next sync without holding up the others.
 */
export async function syncSubscription(
	ctx: Ctx,
	options: MollieOptions,
	initial: Subscription,
	now: Date,
): Promise<{ events: BillingEvent[]; checkedRemote: boolean; errors: string[] }> {
	const gateway = gatewayFor(options);
	const events: BillingEvent[] = [];
	const errors: string[] = [];
	let checkedRemote = false;
	let certain = true;
	const step = async (label: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (error) {
			certain = false;
			if (!(error instanceof OperationInProgressError)) {
				errors.push(`${label}: ${errorMessage(error)}`);
				ctx.context.logger.error(
					`[mollie] Sync of ${initial.id} (${label}) failed: ${errorMessage(error)}`,
				);
			}
		}
	};
	const settle = (label: string, fn: () => Promise<Settlement>) =>
		step(label, async () => {
			const settlement = await fn();
			for (const message of settlement.errors) {
				errors.push(message);
				ctx.context.logger.error(`[mollie] Sync of ${initial.id} (${label}): ${message}`);
			}
			if (settlement.inProgress || settlement.errors.length > 0) certain = false;
		});

	// 1. Payments, without holding the subscription.
	for (const record of await outstandingPayments(ctx, initial.id)) {
		checkedRemote = true;
		await step(record.molliePaymentId, async () => {
			const payment = await gateway.getPayment(record.molliePaymentId);
			events.push(...(await processPayment(ctx, options, payment)).events);
			const due = await refundStillDue(ctx, payment.id);
			if (due) errors.push(due);
		});
	}
	const seen = (await reload(ctx, initial.id)) ?? initial;
	// Customer charges found here; handed to reconciling below so it does not
	// look them up again while holding the subscription.
	let charges: Settlement | undefined;
	if (seen.mollieCustomerId && needsRemoteCheck(seen, now)) {
		checkedRemote = true;
		const remoteId = seen.mollieSubscriptionId;
		// Processing only: Mollie is brought in line below, under the lock.
		if (remoteId) {
			await settle("recent charges", () =>
				settleRecentCharges(ctx, options, seen, { remoteId, reconcile: false }),
			);
		}
		await settle("charges", async () => {
			charges = await settleCustomerCharges(ctx, options, seen, now, { reconcile: false });
			return charges;
		});
	}

	// 2. Decisions, under the lock on the row as it is now.
	await step(initial.id, () =>
		withSubscriptionLock(ctx, initial.id, async (lock) => {
			let current = await reload(ctx, initial.id);
			if (!current) return;
			if (current.status === "incomplete") {
				await expireCheckout(ctx, current, lock);
				return;
			}
			if (BILLING_STATUSES.includes(current.status)) {
				const timed = await applyTimeTransitions(ctx, options, current, now, lock, false);
				events.push(...timed.events);
				current = timed.subscription;
			}
			if (!BILLING_STATUSES.includes(current.status)) {
				// Ended: make sure nothing at Mollie still bills it (e.g. a cancellation
				// that failed at Mollie, or a replacement whose creation was lost).
				if (current.mollieSyncNeeded) {
					checkedRemote = true;
					const known = certain ? charges : undefined;
					await reconcileRemote(ctx, options, current, now, lock, { charges: known });
				}
				return;
			}
			const customerId = current.mollieCustomerId;
			if (!customerId || !needsRemoteCheck(current, now)) return;
			checkedRemote = true;
			const remoteId = current.mollieSubscriptionId;
			if (remoteId) {
				const before = current;
				// Read under the lock, so it is never older than the row it is applied to.
				await step("mollie status", async () => {
					const remote = await findRemote(options, customerId, remoteId);
					if (remote) {
						events.push(...(await reconcileMollieSubscription(ctx, options, before, remote, lock)));
					}
				});
			}
			// First adopt or create the right Mollie subscription (this also finishes
			// an interrupted change), then cancel anything else tagged for this row,
			// each on the row as it is after the previous step.
			await step("mollie", async () => {
				const fresh = await reload(ctx, initial.id);
				const known = certain ? charges : undefined;
				if (fresh) await reconcileRemote(ctx, options, fresh, now, lock, { charges: known });
			});
			await step("orphans", async () => {
				const fresh = await reload(ctx, initial.id);
				if (fresh) await cancelOrphans(ctx, options, fresh, now, lock);
			});
			if (!certain) return;

			let latest = (await reload(ctx, initial.id)) ?? current;
			const grace = gracePeriodDays(options);
			if (
				(latest.status === "active" || latest.status === "trialing") &&
				!latest.cancelAtPeriodEnd &&
				latest.periodEnd &&
				now >= addDays(new Date(latest.periodEnd), grace)
			) {
				// No paid renewal long after the period ended: treat as delinquent.
				latest =
					(await guardedUpdate(
						ctx,
						latest.id,
						["trialing", "active"],
						{ status: "past_due" },
						[
							{ field: "periodEnd", value: new Date(latest.periodEnd) },
							{ field: "cancelAtPeriodEnd", value: false },
						],
						{ lock },
					)) ?? latest;
			}
			const timed = await applyTimeTransitions(ctx, options, latest, now, lock);
			events.push(...timed.events);
			// Mollie was checked for every charge: an unpaid row waits a day for the next check.
			if (timed.subscription.status === "unpaid") {
				await guardedUpdate(ctx, latest.id, ["unpaid"], { mollieCheckedAt: now }, [], { lock });
			}
		}),
	);
	return { events, checkedRemote, errors };
}

/** A payment as it was before Mollie finished it: recorded to be processed later. */
function unprocessed(payment: MolliePayment): MolliePayment {
	return {
		...payment,
		status: "open",
		paidAt: null,
		failedAt: null,
		expiredAt: null,
		canceledAt: null,
	} as MolliePayment;
}

/**
 * How far back the sync lists chargebacks, so that reversals of older ones
 * are seen too (card disputes can take months).
 */
const CHARGEBACK_LIST_DAYS = 120;
/** A chargeback created or reversed this recently may not have been processed. */
const CHARGEBACK_ACTIVITY_DAYS = 14;
/**
 * How long after a payment a recorded chargeback of it is still looked at
 * daily for a reversal (SEPA allows claims for unauthorized debits for 13
 * months).
 */
const CHARGEBACK_RECHECK_DAYS = 540;

/**
 * Chargebacks and reversals whose webhook was never processed (Mollie calls
 * the payment's webhook for each; this is the fallback). Looked at:
 * - our payments with a chargeback created or reversed recently, from the
 *   profile's chargebacks, listed newest first (one request per page);
 * - once a day, payments with a recorded chargeback, whose reversal can
 *   come after the listing no longer reaches it.
 * For each, the complete amount charged back is compared with what was
 * recorded, and the payment is processed again when they differ.
 */
async function settleRecentChargebacks(
	ctx: Ctx,
	options: MollieOptions,
	now: Date,
	onEvents: (events: BillingEvent[]) => void,
	errors: SyncResult["errors"],
): Promise<void> {
	const gateway = gatewayFor(options);
	const candidates = new Set<string>();
	try {
		const since = addDays(now, -CHARGEBACK_ACTIVITY_DAYS).getTime();
		const listed = await gateway.listRecentChargebacks(addDays(now, -CHARGEBACK_LIST_DAYS));
		for (const chargeback of listed) {
			const reversedAt = chargeback.reversedAt ? Date.parse(chargeback.reversedAt) : 0;
			if (Math.max(Date.parse(chargeback.createdAt), reversedAt) >= since) {
				candidates.add(chargeback.paymentId);
			}
		}
	} catch (error) {
		errors.push({ subscriptionId: "", message: `chargebacks: ${errorMessage(error)}` });
		ctx.context.logger.error(`[mollie] Listing chargebacks failed: ${errorMessage(error)}`);
	}
	// Each recorded chargeback, once a day. Few rows: the time is filtered
	// here (a null one, from before this column existed, counts as due).
	// Amounts are decimal strings and a payment without a chargeback has
	// none, so `> "0"` selects exactly the recorded ones (in SQL, and in the
	// memory adapter, where `null >= "0"` would hold). Paged by id, so rows
	// leaving the selection meanwhile (a reversal) do not shift later pages.
	const due = addDays(now, -1).getTime();
	for (let cursor: string | null = null; ; ) {
		const page: MolliePaymentRecord[] = await ctx.context.adapter.findMany<MolliePaymentRecord>({
			model: "molliePayment",
			where: [
				{ field: "amountChargedBack", operator: "gt", value: "0" },
				{ field: "paidAt", operator: "gte", value: addDays(now, -CHARGEBACK_RECHECK_DAYS) },
				...(cursor ? [{ field: "molliePaymentId", operator: "gt" as const, value: cursor }] : []),
			],
			sortBy: { field: "molliePaymentId", direction: "asc" },
			limit: PAGE_SIZE,
		});
		for (const record of page) {
			if (!record.amountChargedBack) continue;
			const checkedAt = record.chargebackCheckedAt;
			if (!checkedAt || new Date(checkedAt).getTime() < due) candidates.add(record.molliePaymentId);
		}
		const last = page.at(-1);
		if (!last || page.length < PAGE_SIZE) break;
		cursor = last.molliePaymentId;
	}
	for (const paymentId of candidates) {
		const record = await findPaymentRecord(ctx, paymentId);
		// Not one of ours.
		if (!record) continue;
		try {
			const recorded = record.amountChargedBack ? toCents(record.amountChargedBack) : 0;
			if ((await gateway.chargedBackCents(paymentId)) === recorded) {
				// Only while it is as read: a reversal processed meanwhile wins.
				if (recorded > 0) {
					await ctx.context.adapter.incrementOne<MolliePaymentRecord>({
						model: "molliePayment",
						where: [
							{ field: "molliePaymentId", value: paymentId },
							{ field: "amountChargedBack", value: record.amountChargedBack ?? null },
						],
						increment: {},
						set: { chargebackCheckedAt: now },
					});
				}
				continue;
			}
			const payment = await gateway.getPayment(paymentId);
			onEvents((await processPayment(ctx, options, payment)).events);
		} catch (error) {
			if (error instanceof OperationInProgressError) continue;
			errors.push({ subscriptionId: record.subscriptionId, message: errorMessage(error) });
			ctx.context.logger.error(
				`[mollie] Processing the chargeback of ${paymentId} failed: ${errorMessage(error)}`,
			);
		}
	}
}

/**
 * Pro-rata charges whose creation was interrupted before they were recorded
 * (the response was lost, or the process stopped): each upgrade attempt has
 * its own journal entry, which nothing else revisits. Once its lock lease is
 * long over, the charge is looked up at Mollie by its operation key; if it
 * exists it is processed (a charge without its upgrade is refunded), and if
 * Mollie no longer remembers the key and nothing carries it, it never
 * happened.
 */
async function recoverAbandonedCharges(
	ctx: Ctx,
	options: MollieOptions,
	now: Date,
	onEvents: (events: BillingEvent[]) => void,
	errors: SyncResult["errors"],
): Promise<void> {
	const gateway = gatewayFor(options);
	const abandoned = await pendingOperations(
		ctx.context,
		"create_proration_payment",
		new Date(now.getTime() - LOCK_LEASE_MS),
	);
	for (const op of abandoned) {
		// `proration:<subscriptionId>:<plan>:<period end>:<attempt>#<n>`
		const subscriptionId = op.idempotencyKey.split(":")[1] ?? "";
		const subscription = await reload(ctx, subscriptionId);
		const customerId = subscription?.mollieCustomerId;
		if (!subscription || !customerId) continue;
		try {
			const createdAt = new Date(op.createdAt);
			const found = await gateway.findCustomerPaymentByOperationKey(
				customerId,
				await mollieKey(op.idempotencyKey),
				createdAt,
			);
			if (found) {
				// Recorded first, as not yet processed (open): from then on the
				// payment is outstanding locally and every sync processes it until
				// settled, and processing still sees its change to paid or failed
				// (so its hooks run).
				const payment = await gateway.getPayment(found);
				await recordPayment(ctx, unprocessed(payment), subscription.id);
				await resolveOperation(ctx.context, op.idempotencyKey, "succeeded", found);
				onEvents((await processPayment(ctx, options, payment)).events);
			} else if (now.getTime() - createdAt.getTime() > REPLAY_WINDOW_MS) {
				await resolveOperation(ctx.context, op.idempotencyKey, "failed", null);
			}
		} catch (error) {
			if (error instanceof OperationInProgressError) continue;
			errors.push({ subscriptionId, message: errorMessage(error) });
			ctx.context.logger.error(
				`[mollie] Recovering ${op.idempotencyKey} failed: ${errorMessage(error)}`,
			);
		}
	}
}

/** A refund attempt younger than this is taken to be still in progress. */
const REFUND_IN_FLIGHT_MS = 15 * 60 * 1000;

/**
 * A sync error for a duplicate whose refund did not go through, if so: not
 * for one whose refund is still in progress (a recent pending attempt).
 */
async function refundStillDue(ctx: Ctx, molliePaymentId: string): Promise<string | null> {
	const record = await findPaymentRecord(ctx, molliePaymentId);
	if (record?.status !== "paid" || record.outcome !== "duplicate") return null;
	const prefix = `refund:${molliePaymentId}#`;
	const attempts = await ctx.context.adapter.findMany<{
		idempotencyKey: string;
		status: string;
		createdAt: Date;
	}>({
		model: "mollieOperation",
		where: [
			{ field: "kind", value: "create_refund" },
			{ field: "idempotencyKey", operator: "starts_with", value: prefix },
			{ field: "status", value: "pending" },
		],
		limit: 10,
	});
	const inFlight = attempts.some(
		(op) =>
			op.idempotencyKey.startsWith(prefix) &&
			Date.now() - new Date(op.createdAt).getTime() < REFUND_IN_FLIGHT_MS,
	);
	if (inFlight) return null;
	const message = `${molliePaymentId}: refund of a duplicate payment is still due`;
	ctx.context.logger.error(`[mollie] ${message}`);
	return message;
}

export type SyncResult = {
	checked: number;
	remoteChecked: number;
	/** Sales invoices created for paid payments that were missed earlier. */
	invoicesCreated: number;
	errors: { subscriptionId: string; message: string }[];
};

/**
 * Runs `syncSubscription` over every subscription that may still change,
 * then catches up on missed sales invoices.
 */
export async function syncAllSubscriptions(
	ctx: Ctx,
	options: MollieOptions,
	input: { now?: Date | undefined; onEvents: (events: BillingEvent[]) => void },
): Promise<SyncResult> {
	const now = input.now ?? new Date();
	const ids = new Set<string>();
	// Subscriptions that may still change, and any (also ended ones) with a
	// change that still has to reach Mollie.
	const selections: Where[][] = [
		[{ field: "status", operator: "in", value: [...SYNCABLE_STATUSES] }],
		[{ field: "mollieSyncNeeded", value: true }],
	];
	for (const where of selections) {
		for (let offset = 0; ; offset += PAGE_SIZE) {
			const page = await ctx.context.adapter.findMany<Pick<Subscription, "id">>({
				model: "subscription",
				where,
				select: ["id"],
				sortBy: { field: "id", direction: "asc" },
				limit: PAGE_SIZE,
				offset,
			});
			for (const row of page) ids.add(row.id);
			if (page.length < PAGE_SIZE) break;
		}
	}
	const result: SyncResult = { checked: 0, remoteChecked: 0, invoicesCreated: 0, errors: [] };
	await recoverAbandonedCharges(ctx, options, now, input.onEvents, result.errors);
	await settleRecentChargebacks(ctx, options, now, input.onEvents, result.errors);
	for (const id of ids) {
		const subscription = await reload(ctx, id);
		if (!subscription) continue;
		result.checked++;
		try {
			const synced = await syncSubscription(ctx, options, subscription, now);
			if (synced.checkedRemote) result.remoteChecked++;
			input.onEvents(synced.events);
			for (const message of synced.errors) result.errors.push({ subscriptionId: id, message });
		} catch (error) {
			if (error instanceof OperationInProgressError) continue;
			result.errors.push({ subscriptionId: id, message: errorMessage(error) });
			ctx.context.logger.error(`[mollie] Sync of ${id} failed: ${errorMessage(error)}`);
		}
	}
	// Paid payments of subscriptions that are not synced (e.g. canceled) whose
	// outcome is not settled: typically a refund of a duplicate still due.
	const synced = new Set(ids);
	for (const record of await outstandingPayments(ctx)) {
		if (synced.has(record.subscriptionId)) continue;
		try {
			const payment = await gatewayFor(options).getPayment(record.molliePaymentId);
			input.onEvents((await processPayment(ctx, options, payment)).events);
			const due = await refundStillDue(ctx, payment.id);
			if (due) result.errors.push({ subscriptionId: record.subscriptionId, message: due });
		} catch (error) {
			if (error instanceof OperationInProgressError) continue;
			result.errors.push({ subscriptionId: record.subscriptionId, message: errorMessage(error) });
			ctx.context.logger.error(
				`[mollie] Processing ${record.molliePaymentId} failed: ${errorMessage(error)}`,
			);
		}
	}
	result.invoicesCreated = await catchUpSalesInvoices(
		ctx,
		options,
		now,
		async (record, subscription) => {
			const payment = await gatewayFor(options).getPayment(record.molliePaymentId);
			return paymentHookData(options, payment, record, subscription);
		},
		(record, message) => result.errors.push({ subscriptionId: record.subscriptionId, message }),
	);
	return result;
}
