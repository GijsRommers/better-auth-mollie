import type { GenericEndpointContext, Where } from "better-auth";
import { type BillingEvent, dispatchEvents } from "./events";
import { gatewayFor, type MolliePayment, type MollieSubscription, metadataOf } from "./gateway";
import { type SubscriptionLock, withSubscriptionLock } from "./lock";
import {
	LOCK_LEASE_MS,
	LockLostError,
	mollieKey,
	OperationInProgressError,
	pendingOperations,
	REPLAY_WINDOW_MS,
	resolveOperation,
	runOperation,
} from "./operations";
import { catchUpSalesInvoices } from "./sales-invoices";
import {
	ACCESS_STATUSES,
	BILLING_STATUSES,
	canAdvancePayment,
	DEFAULT_GRACE_PERIOD_DAYS,
	isFailedPaymentStatus,
	isFinalPaymentStatus,
	mapMollieSubscriptionStatus,
	SYNCABLE_STATUSES,
} from "./status";
import { chargeAmount, resolveTax, taxMetadata, trustedTax } from "./tax";
import type {
	CustomerType,
	MollieOptions,
	MolliePaymentRecord,
	MolliePlan,
	PaymentHookData,
	PaymentOutcome,
	PaymentPurpose,
	Subscription,
	SubscriptionStatus,
	TaxBreakdown,
} from "./types";
import {
	addDays,
	addInterval,
	billingCycle,
	ceilToUTCDate,
	errorMessage,
	fromMollieDate,
	getPlanByName,
	getWebhookUrl,
	isMollieApiError,
	isMollieNotFound,
	parseInterval,
	planCurrency,
	toDate,
	toMollieDate,
} from "./utils";

type Ctx = GenericEndpointContext;

export type ProcessResult = {
	subscription: Subscription | null;
	events: BillingEvent[];
	/** Set when the payment does not belong to any local subscription. */
	ignored?: string | undefined;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function gracePeriodDays(options: MollieOptions): number {
	return options.subscription?.enabled
		? (options.subscription.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS)
		: DEFAULT_GRACE_PERIOD_DAYS;
}

export async function findSubscription(ctx: Ctx, where: Where[]): Promise<Subscription | null> {
	return ctx.context.adapter.findOne<Subscription>({ model: "subscription", where });
}

async function reload(ctx: Ctx, id: string): Promise<Subscription | null> {
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
async function flagMollieSync(ctx: Ctx, id: string): Promise<void> {
	await ctx.context.adapter.incrementOne<Subscription>({
		model: "subscription",
		where: [{ field: "id", value: id }],
		increment: {},
		set: { mollieSyncNeeded: true },
	});
}

/**
 * Clears `mollieSyncNeeded` after Mollie was brought in line with `seen`,
 * unless the row changed again since (its revision moved on).
 */
async function markMollieSynced(
	ctx: Ctx,
	seen: Subscription,
	result: Subscription,
): Promise<Subscription> {
	if (!seen.mollieSyncNeeded) return result;
	const cleared = await ctx.context.adapter.incrementOne<Subscription>({
		model: "subscription",
		where: [
			{ field: "id", value: seen.id },
			{ field: "mollieSyncRevision", value: seen.mollieSyncRevision ?? 0 },
		],
		increment: {},
		set: { mollieSyncNeeded: false },
	});
	return cleared ?? result;
}

/** The recorded outcome of a payment, if it is recorded. */
export async function paymentOutcome(
	ctx: Ctx,
	molliePaymentId: string,
): Promise<PaymentOutcome | null> {
	return (await findPaymentRecord(ctx, molliePaymentId))?.outcome ?? null;
}

async function findPaymentRecord(
	ctx: Ctx,
	molliePaymentId: string,
): Promise<MolliePaymentRecord | null> {
	return ctx.context.adapter.findOne<MolliePaymentRecord>({
		model: "molliePayment",
		where: [{ field: "molliePaymentId", value: molliePaymentId }],
	});
}

/** Moves a payment's outcome `from → to` atomically; `null` if it was not in `from`. */
async function setOutcome(
	ctx: Ctx,
	molliePaymentId: string,
	from: readonly PaymentOutcome[],
	to: PaymentOutcome,
	claim?: number,
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
		set: { outcome: to },
	});
}

/**
 * Claims a payment for the holder of `lock` before it reads the payment's
 * outcome and decides on it. Lock serials only grow, so once a newer holder
 * (one that took over an expired lease) has claimed the payment, the older
 * holder's outcome writes no longer apply: deciding on a payment and
 * recording that decision cannot be split across two holders.
 */
async function claimPayment(
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

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Finds the local subscription a Mollie payment belongs to. Subscription
 * payments resolve by `mollieSubscriptionId`; first payments by their
 * `molliePayment` row. Payment metadata (set by us, read back from Mollie) is
 * a fallback, only accepted when the Mollie customer matches.
 */
async function resolveSubscription(ctx: Ctx, payment: MolliePayment): Promise<Subscription | null> {
	if (payment.subscriptionId) {
		const bySubscription = await findSubscription(ctx, [
			{ field: "mollieSubscriptionId", value: payment.subscriptionId },
		]);
		if (bySubscription) return bySubscription;
	}
	const record = await ctx.context.adapter.findOne<MolliePaymentRecord>({
		model: "molliePayment",
		where: [{ field: "molliePaymentId", value: payment.id }],
	});
	if (record) return findSubscription(ctx, [{ field: "id", value: record.subscriptionId }]);
	const localId = metadataOf(payment).subscriptionId;
	if (typeof localId !== "string") return null;
	const subscription = await findSubscription(ctx, [{ field: "id", value: localId }]);
	if (!subscription || !payment.customerId) return null;
	return subscription.mollieCustomerId === payment.customerId ? subscription : null;
}

function terminalTimestamp(payment: MolliePayment): Date | null {
	return toDate(payment.failedAt ?? payment.expiredAt ?? payment.canceledAt);
}

/**
 * Records a payment idempotently. Status only moves forward; `transitioned`
 * is `true` for exactly one caller: the one that moved it to a final status
 * (or first saw it there).
 */
export async function recordPayment(
	ctx: Ctx,
	payment: MolliePayment,
	subscriptionId: string,
): Promise<{ record: MolliePaymentRecord; transitioned: boolean }> {
	const { adapter } = ctx.context;
	const where: Where[] = [{ field: "molliePaymentId", value: payment.id }];
	const status = payment.status as MolliePaymentRecord["status"];
	const timestamps = {
		paidAt: toDate(payment.paidAt),
		failedAt: status === "paid" ? null : terminalTimestamp(payment),
	};
	let existing = await adapter.findOne<MolliePaymentRecord>({ model: "molliePayment", where });
	if (!existing) {
		try {
			const created = await adapter.create<Omit<MolliePaymentRecord, "id">, MolliePaymentRecord>({
				model: "molliePayment",
				data: {
					molliePaymentId: payment.id,
					subscriptionId,
					amount: payment.amount.value,
					currency: payment.amount.currency,
					status,
					sequenceType: payment.sequenceType as MolliePaymentRecord["sequenceType"],
					outcome: "pending",
					claimSerial: 0,
					...timestamps,
				},
			});
			return { record: created, transitioned: isFinalPaymentStatus(status) };
		} catch (error) {
			// Unique molliePaymentId: someone else recorded it first.
			existing = await adapter.findOne<MolliePaymentRecord>({ model: "molliePayment", where });
			if (!existing) throw error;
		}
	}
	if (!canAdvancePayment(existing.status, status)) return { record: existing, transitioned: false };
	const updated = await adapter.incrementOne<MolliePaymentRecord>({
		model: "molliePayment",
		where: [...where, { field: "status", value: existing.status }],
		increment: {},
		set: { status, ...timestamps },
	});
	if (!updated) {
		const current = await adapter.findOne<MolliePaymentRecord>({ model: "molliePayment", where });
		return { record: current ?? existing, transitioned: false };
	}
	return { record: updated, transitioned: isFinalPaymentStatus(status) };
}

const PURPOSES: readonly PaymentPurpose[] = [
	"checkout",
	"verification",
	"renewal",
	"proration",
	"recovery",
];

/** Why a payment exists, from the metadata we set (or its sequence type). */
export function paymentPurpose(payment: MolliePayment): PaymentPurpose {
	const metadata = metadataOf(payment);
	if (
		typeof metadata.purpose === "string" &&
		PURPOSES.includes(metadata.purpose as PaymentPurpose)
	) {
		return metadata.purpose as PaymentPurpose;
	}
	if (payment.sequenceType === "first")
		return metadata.trial === true ? "verification" : "checkout";
	return "renewal";
}

/** What hooks (and sales invoices) receive about a payment. */
export async function paymentHookData(
	options: MollieOptions,
	payment: MolliePayment,
	record: MolliePaymentRecord,
	subscription: Subscription,
): Promise<PaymentHookData> {
	const metadata = metadataOf(payment);
	const purpose = paymentPurpose(payment);
	const planName = typeof metadata.plan === "string" ? metadata.plan : subscription.plan;
	return {
		payment,
		purpose,
		record,
		subscription,
		plan: await getPlanByName(options, planName),
		isVerification: purpose === "verification",
		tax: purpose === "verification" ? null : trustedTax(options, metadata, payment.amount.currency),
	};
}

/** What applying a paid payment did. */
type Application =
	| { kind: "applied"; subscription: Subscription; activated: boolean }
	/** It cannot apply: what it would pay for is already paid for, or over. */
	| { kind: "covered" }
	/** It cannot apply now (e.g. a plan that is not configured); try again later. */
	| { kind: "unresolved" };

const APPLY_ATTEMPTS = 3;

function refundsEnabled(options: MollieOptions): boolean {
	return !!options.subscription?.enabled && options.subscription.refundDuplicatePayments !== false;
}

/**
 * Applies a payment fetched from Mollie to local state. Safe to call any
 * number of times for the same payment, from any number of processes:
 *
 * - every paid payment gets a durable `outcome`: `applied` when it paid for
 *   the subscription (activation, recovery, renewal), or `duplicate` when
 *   what it pays for is already paid for (two checkouts, a recovery racing
 *   Mollie's own retry, a charge by a replaced Mollie subscription);
 * - which payment applied is recorded on the subscription in the same atomic
 *   update (`appliedPaymentId`), so a delivery that lost a race can tell
 *   "this payment was applied" from "another payment paid for this";
 * - a duplicate is refunded (journaled, at most once), and a refund that
 *   failed or was interrupted is retried by the next delivery or sync;
 * - hook events are emitted once per transition;
 * - it runs under the subscription's lock (or the one the caller holds), so
 *   it never interleaves with another payment, a plan change, a cancel or a
 *   restore of the same subscription. `reconcile` (default: when not given
 *   a lock) then brings Mollie in line, still under the lock.
 */
export async function processPayment(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
	opts: { lock?: SubscriptionLock | undefined; reconcile?: boolean } = {},
): Promise<ProcessResult> {
	const target = await resolveSubscription(ctx, payment);
	if (!target) return { subscription: null, events: [], ignored: "unknown payment" };
	if (opts.lock?.subscriptionId === target.id) {
		const fresh = (await reload(ctx, target.id)) ?? target;
		return applyPayment(ctx, options, payment, fresh, opts.lock, opts.reconcile ?? false);
	}
	return withSubscriptionLock(
		ctx,
		target.id,
		async (lock) => {
			const fresh = (await reload(ctx, target.id)) ?? target;
			return applyPayment(ctx, options, payment, fresh, lock, opts.reconcile ?? true);
		},
		{ waitMs: LOCK_WAIT_MS },
	);
}

/** How long a payment (or a request) waits for a subscription that is busy. */
export const LOCK_WAIT_MS = 2000;

async function applyPayment(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
	initial: Subscription,
	lock: SubscriptionLock,
	reconcile: boolean,
): Promise<ProcessResult> {
	let subscription = initial;
	const recorded = await recordPayment(ctx, payment, subscription.id);
	let record = await claimPayment(ctx, payment.id, lock);
	const claim = lock.serial;
	const purpose = paymentPurpose(payment);
	const status = payment.status as string;
	const events: BillingEvent[] = [];
	const duplicateEvents: BillingEvent[] = [];
	let activated = false;

	if (status === "paid" && record.outcome === "pending") {
		const result = await applyPaidPayment(ctx, options, subscription, payment, purpose, lock);
		if (result.kind === "applied") {
			subscription = result.subscription;
			if (result.activated) {
				activated = true;
				const plan = await getPlanByName(options, subscription.plan);
				events.push({ type: "subscription.activated", subscription, plan, payment });
			}
			record = (await setOutcome(ctx, payment.id, ["pending"], "applied", claim)) ?? record;
		} else {
			subscription = (await reload(ctx, subscription.id)) ?? subscription;
			if (subscription.appliedPaymentId === payment.id) {
				// Applied by a concurrent delivery of this same payment.
				record = (await setOutcome(ctx, payment.id, ["pending"], "applied", claim)) ?? record;
			} else if (result.kind === "covered") {
				const classified = await classifyDuplicate(ctx, options, payment, subscription, claim);
				record = classified.record ?? record;
				duplicateEvents.push(...classified.events);
			}
		}
	} else if (isFinalPaymentStatus(status) && status !== "paid" && isUnhandled(record)) {
		// Not paid. Its consequence is applied first and recorded as handled
		// after, so a stop in between is repaired by the next delivery or sync.
		if (purpose === "checkout" || purpose === "verification") {
			// Driven by the payment's state, not by who saw it change first, so
			// a crash right after recording the payment is repaired next time.
			subscription = (await expireCheckout(ctx, subscription, lock)) ?? subscription;
		} else if (
			isFailedPaymentStatus(status) &&
			(purpose === "renewal" ||
				// A failed pro-rata charge only matters for an upgrade that was
				// applied: the current one, or an earlier one a later upgrade
				// replaced (which recorded this charge as applied).
				(purpose === "proration" &&
					(subscription.appliedPaymentId === payment.id || record.outcome === "applied")))
		) {
			subscription =
				(await applyFailedRenewal(ctx, options, subscription, payment, lock)) ?? subscription;
		}
		// A failed recovery leaves the subscription as it was.
		// Only while the lease still holds: a consequence that was not applied
		// because the lease expired must stay to be done (fence throws then).
		await lock.fence();
		record = (await setOutcome(ctx, payment.id, UNHANDLED, "handled", claim)) ?? record;
	}

	if (recorded.transitioned && (status === "paid" || isFailedPaymentStatus(status))) {
		const latest = (await reload(ctx, subscription.id)) ?? subscription;
		const current = (await findPaymentRecord(ctx, payment.id)) ?? record;
		const data = await paymentHookData(options, payment, current, latest);
		events.push({ type: status === "paid" ? "payment.paid" : "payment.failed", data });
	}
	events.push(...duplicateEvents);
	if (status === "paid") {
		const current = (await findPaymentRecord(ctx, payment.id)) ?? record;
		if (current.outcome === "duplicate") {
			try {
				events.push(...(await refundDuplicate(ctx, options, payment, subscription, claim)));
			} catch (error) {
				// The refund stays due (outcome `duplicate`) and the sync retries it;
				// the events of this delivery are not lost meanwhile.
				ctx.context.logger.error(
					`[mollie] Refund of ${payment.id} failed; the next sync retries it: ${errorMessage(error)}`,
				);
			}
		}
	}
	// A new mandate, a new start or a postponed change: bring Mollie in line.
	if (reconcile && (activated || subscription.mollieSyncNeeded || needsRemote(subscription))) {
		subscription = await reconcileQuietly(ctx, options, subscription.id, lock);
	}
	return { subscription, events };
}

async function applyPaidPayment(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
	purpose: PaymentPurpose,
	lock: SubscriptionLock,
): Promise<Application> {
	switch (purpose) {
		case "checkout":
		case "verification":
			return activateSubscription(ctx, options, subscription, payment, lock);
		case "recovery":
			return recoverSubscription(ctx, options, subscription, payment, lock);
		case "renewal":
			return applyRenewal(ctx, options, subscription, payment, lock);
		case "proration":
			return applyProration(subscription, payment);
	}
}

/**
 * A pro-rata charge must not be judged before the upgrade that made it had
 * its chance to be recorded. After this, an upgrade that was not recorded
 * never will be: its lock lease (renewed right before charging) expired long
 * ago, and an expired lease cannot be renewed.
 */
const PRORATION_GRACE_MS = 10 * 60 * 1000;

/**
 * A pro-rata charge pays for the upgrade that recorded it as the applied
 * payment, in the same update that changed the plan. If that never
 * happened (the upgrade lost a race, or the process stopped right after
 * charging), the customer paid for nothing: covered, so it is refunded.
 */
function applyProration(subscription: Subscription, payment: MolliePayment): Application {
	if (subscription.appliedPaymentId === payment.id) {
		return { kind: "applied", subscription, activated: false };
	}
	const age = Date.now() - new Date(payment.createdAt).getTime();
	return age < PRORATION_GRACE_MS ? { kind: "unresolved" } : { kind: "covered" };
}

/**
 * A paid payment that cannot apply: record it as a duplicate (refund due) or
 * as kept (`refundDuplicatePayments: false`). Exactly one caller wins this;
 * it also stops the Mollie subscription that charged it, if that is a
 * replaced or stray one of this subscription.
 */
async function classifyDuplicate(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
	subscription: Subscription,
	claim: number,
): Promise<{ record: MolliePaymentRecord | null; events: BillingEvent[] }> {
	const refund = refundsEnabled(options);
	const marked = await setOutcome(
		ctx,
		payment.id,
		["pending"],
		refund ? "duplicate" : "kept",
		claim,
	);
	if (!marked) return { record: await findPaymentRecord(ctx, payment.id), events: [] };
	ctx.context.logger.warn(
		`[mollie] Payment ${payment.id} pays for something already paid on ${subscription.id}${refund ? "; refunding" : ""}`,
	);
	if (
		payment.subscriptionId &&
		payment.subscriptionId !== subscription.mollieSubscriptionId &&
		metadataOf(payment).subscriptionId === subscription.id
	) {
		try {
			await cancelMollieSubscription(ctx, options, {
				...subscription,
				mollieSubscriptionId: payment.subscriptionId,
			});
		} catch (error) {
			// The orphan sweep of the next sync stops it too.
			ctx.context.logger.error(
				`[mollie] Could not cancel ${payment.subscriptionId}: ${errorMessage(error)}`,
			);
		}
	}
	const events: BillingEvent[] = refund
		? []
		: [
				{
					type: "payment.duplicate",
					data: await paymentHookData(options, payment, marked, subscription),
					refunded: false,
				},
			];
	return { record: marked, events };
}

/**
 * Refunds a payment recorded as a duplicate (journaled: at most once) and
 * records that. Throws if Mollie refuses or fails, so the webhook is retried;
 * the sync retries it too.
 */
async function refundDuplicate(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
	subscription: Subscription,
	claim?: number,
): Promise<BillingEvent[]> {
	await refundPayment(ctx, options, subscription, payment);
	const refunded = await setOutcome(ctx, payment.id, ["duplicate"], "refunded", claim);
	if (!refunded) return [];
	return [
		{
			type: "payment.duplicate",
			data: await paymentHookData(options, payment, refunded, subscription),
			refunded: true,
		},
	];
}

/**
 * Refunds a payment that was charged for a change that did not go through
 * (e.g. the pro-rata charge of an upgrade that lost a race). The refund is
 * recorded as due first, so if refunding fails here (or the payment is not
 * paid yet), the next delivery or sync of the payment refunds it.
 */
export async function refundUnappliedPayment(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
): Promise<BillingEvent[]> {
	// Only a charge nobody applied: each upgrade attempt charges its own
	// payment, so an applied outcome means the upgrade did go through.
	const marked = await setOutcome(ctx, payment.id, ["pending"], "duplicate");
	if (!marked || payment.status !== "paid") return [];
	return refundDuplicate(ctx, options, payment, subscription);
}

/**
 * First payment paid: move `incomplete → trialing | active` with the new
 * mandate and the plan that was paid for. The Mollie subscription is created
 * afterwards by `ensureRemote`. Only one payment can win the guarded update;
 * a paid first payment for a row that is no longer `incomplete` is covered.
 */
async function activateSubscription(
	ctx: Ctx,
	options: MollieOptions,
	initial: Subscription,
	payment: MolliePayment,
	lock: SubscriptionLock,
): Promise<Application> {
	const metadata = metadataOf(payment);
	const plan = await getPlanByName(
		options,
		typeof metadata.plan === "string" ? metadata.plan : initial.plan,
	);
	const customerId = payment.customerId ?? initial.mollieCustomerId;
	if (!plan || !payment.mandateId || !customerId) {
		ctx.context.logger.error(
			`[mollie] Cannot activate ${initial.id} from payment ${payment.id}: plan or mandate missing`,
		);
		return { kind: "unresolved" };
	}
	const anchor = toDate(payment.paidAt) ?? new Date(payment.createdAt);
	const trialDays = typeof metadata.trialDays === "number" ? metadata.trialDays : 0;
	const isTrial = metadata.trial === true && trialDays > 0;
	const trialEnd = isTrial ? ceilToUTCDate(addDays(anchor, trialDays)) : null;
	const periodEnd = trialEnd ?? ceilToUTCDate(addInterval(anchor, plan.interval));
	let subscription: Subscription | null = initial;
	for (let attempt = 0; attempt < APPLY_ATTEMPTS && subscription; attempt++) {
		if (subscription.status !== "incomplete") return { kind: "covered" };
		await settlePreviousPayment(ctx, subscription, payment);
		const updated = await guardedUpdate(
			ctx,
			subscription.id,
			["incomplete"],
			{
				status: isTrial ? "trialing" : "active",
				plan: plan.name.toLowerCase(),
				pendingPlan: null,
				mollieCustomerId: customerId,
				mollieMandateId: payment.mandateId,
				periodStart: anchor,
				periodEnd,
				trialEnd,
				cancelAtPeriodEnd: false,
				appliedPaymentId: payment.id,
			},
			[],
			{ mollieSync: true, lock },
		);
		if (updated) return { kind: "applied", subscription: updated, activated: true };
		subscription = await reload(ctx, subscription.id);
	}
	return subscription ? { kind: "unresolved" } : { kind: "covered" };
}

/**
 * Recovery payment paid: a `past_due` or `unpaid` subscription restarts with
 * a fresh period on the new mandate. Only for a delinquency that began before
 * this payment, so replaying an old recovery payment never restarts a later
 * one. `ensureRemote` then moves billing to the new mandate.
 */
async function recoverSubscription(
	ctx: Ctx,
	options: MollieOptions,
	initial: Subscription,
	payment: MolliePayment,
	lock: SubscriptionLock,
): Promise<Application> {
	const metadata = metadataOf(payment);
	const plan = await getPlanByName(
		options,
		typeof metadata.plan === "string" ? metadata.plan : initial.plan,
	);
	const customerId = payment.customerId ?? initial.mollieCustomerId;
	if (!plan || !payment.mandateId || !customerId) {
		ctx.context.logger.error(`[mollie] Cannot recover ${initial.id} from payment ${payment.id}`);
		return { kind: "unresolved" };
	}
	const anchor = toDate(payment.paidAt) ?? new Date(payment.createdAt);
	let subscription: Subscription | null = initial;
	for (let attempt = 0; attempt < APPLY_ATTEMPTS && subscription; attempt++) {
		if (subscription.status !== "past_due" && subscription.status !== "unpaid") {
			return { kind: "covered" };
		}
		// Canceled after the recovery checkout started: the newer intent wins.
		if (subscription.cancelAtPeriodEnd) return { kind: "covered" };
		const periodStart = subscription.periodStart ? new Date(subscription.periodStart) : null;
		if (periodStart && periodStart >= anchor) return { kind: "covered" };
		await settlePreviousPayment(ctx, subscription, payment);
		const updated = await guardedUpdate(
			ctx,
			subscription.id,
			["past_due", "unpaid"],
			{
				status: "active",
				plan: plan.name.toLowerCase(),
				pendingPlan: null,
				mollieCustomerId: customerId,
				mollieMandateId: payment.mandateId,
				periodStart: anchor,
				periodEnd: ceilToUTCDate(addInterval(anchor, plan.interval)),
				cancelAtPeriodEnd: false,
				appliedPaymentId: payment.id,
			},
			[
				{ field: "cancelAtPeriodEnd", value: false },
				...(periodStart ? [{ field: "periodStart", value: periodStart }] : []),
				...sameAppliedPayment(subscription),
			],
			{ mollieSync: true, lock },
		);
		if (updated) return { kind: "applied", subscription: updated, activated: true };
		subscription = await reload(ctx, subscription.id);
	}
	return subscription ? { kind: "unresolved" } : { kind: "covered" };
}

/**
 * A first payment failed, expired or was canceled. The checkout is over
 * unless another attempt for this subscription is still open or paid.
 */
async function expireCheckout(
	ctx: Ctx,
	subscription: Subscription,
	lock?: SubscriptionLock,
): Promise<Subscription | null> {
	if (subscription.status !== "incomplete") return null;
	const attempts = await ctx.context.adapter.findMany<MolliePaymentRecord>({
		model: "molliePayment",
		where: [
			{ field: "subscriptionId", value: subscription.id },
			{ field: "sequenceType", value: "first" },
		],
		limit: 100,
	});
	if (attempts.length === 0) return null;
	if (attempts.some((a) => !isFinalPaymentStatus(a.status) || a.status === "paid")) return null;
	return guardedUpdate(ctx, subscription.id, ["incomplete"], { status: "incomplete_expired" }, [], {
		lock,
	});
}

/**
 * A recurring payment was paid: advance the period and move
 * `trialing`/`past_due`/`unpaid` to `active`.
 *
 * Only the Mollie subscription the row bills with pays for its periods. A
 * payment pays for exactly one billing cycle of it: the cycle (anchored on
 * the Mollie subscription's `startDate`) in which it was created. That
 * depends only on immutable facts, so re-processing a payment can never
 * stretch what it paid for, and a late retry still pays for its own cycle.
 *
 * Covered (a duplicate): a charge by a replaced or stray Mollie subscription,
 * a cycle that is already paid for, or one that overlaps time that is (a
 * cycle never legitimately starts before the paid-up period ends). If the
 * Mollie subscription cannot be read, this throws, so the webhook is retried
 * rather than guessed.
 */
async function applyRenewal(
	ctx: Ctx,
	options: MollieOptions,
	initial: Subscription,
	payment: MolliePayment,
	lock: SubscriptionLock,
): Promise<Application> {
	const customerId = payment.customerId ?? initial.mollieCustomerId;
	const remoteId = payment.subscriptionId;
	if (!remoteId || !customerId) return { kind: "unresolved" };
	const billedPlan = metadataOf(payment).plan;
	let cycle: { start: Date; end: Date } | null = null;
	let subscription: Subscription | null = initial;
	for (let attempt = 0; attempt < APPLY_ATTEMPTS && subscription; attempt++) {
		if (!BILLING_STATUSES.includes(subscription.status)) return { kind: "covered" };
		if (remoteId !== subscription.mollieSubscriptionId) return { kind: "covered" };
		// Canceled: a charge Mollie still made (e.g. stopping it failed) pays
		// for a period the customer canceled, so it is refunded.
		if (subscription.cancelAtPeriodEnd) return { kind: "covered" };
		if (!cycle) {
			const remote = await gatewayFor(options).getSubscription(customerId, remoteId);
			cycle = billingCycle(
				fromMollieDate(remote.startDate),
				remote.interval,
				new Date(payment.createdAt),
			);
		}
		const currentEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
		if (
			currentEnd &&
			(cycle.end <= currentEnd || cycle.start.getTime() < currentEnd.getTime() - DAY_MS)
		) {
			return { kind: "covered" };
		}
		// The first charge of a scheduled plan change: that plan is now active.
		const switchPlan = !!subscription.pendingPlan && billedPlan === subscription.pendingPlan;
		const guards: Where[] = [
			{ field: "mollieSubscriptionId", value: remoteId },
			{ field: "cancelAtPeriodEnd", value: false },
			...sameAppliedPayment(subscription),
		];
		if (currentEnd) guards.push({ field: "periodEnd", value: currentEnd });
		if (switchPlan) {
			guards.push({ field: "pendingPlan", value: subscription.pendingPlan as string });
		}
		await settlePreviousPayment(ctx, subscription, payment);
		const updated = await guardedUpdate(
			ctx,
			subscription.id,
			BILLING_STATUSES,
			{
				status: "active",
				periodStart: cycle.start,
				periodEnd: cycle.end,
				appliedPaymentId: payment.id,
				...(switchPlan ? { plan: subscription.pendingPlan as string, pendingPlan: null } : {}),
			},
			guards,
			{ lock },
		);
		if (updated) return { kind: "applied", subscription: updated, activated: false };
		subscription = await reload(ctx, subscription.id);
	}
	return subscription ? { kind: "unresolved" } : { kind: "covered" };
}

/**
 * A charge failed: `trialing | active → past_due`, unless what it was for is
 * paid anyway or no longer relevant:
 * - a renewal: when the billing cycle it was charged for is already paid
 *   (e.g. a retry for that cycle succeeded, also if this failure is processed
 *   again later), or when it comes from a replaced Mollie subscription;
 * - a pro-rata charge: when it predates the current period (a renewal or a
 *   recovery started a new one since).
 * Guarded on the period it checked, so a renewal that lands concurrently wins.
 */
async function applyFailedRenewal(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
	lock: SubscriptionLock,
): Promise<Subscription | null> {
	if (subscription.status !== "trialing" && subscription.status !== "active") return null;
	if (subscription.cancelAtPeriodEnd) return null;
	const createdAt = new Date(payment.createdAt);
	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
	if (payment.subscriptionId) {
		if (payment.subscriptionId !== subscription.mollieSubscriptionId) return null;
		const customerId = payment.customerId ?? subscription.mollieCustomerId;
		if (!customerId) return null;
		const remote = await gatewayFor(options).getSubscription(customerId, payment.subscriptionId);
		const cycle = billingCycle(fromMollieDate(remote.startDate), remote.interval, createdAt);
		if (periodEnd && cycle.end <= periodEnd) return null;
	} else if (subscription.periodStart && createdAt < new Date(subscription.periodStart)) {
		return null;
	}
	return guardedUpdate(
		ctx,
		subscription.id,
		["trialing", "active"],
		{ status: "past_due" },
		subscription.periodEnd ? [{ field: "periodEnd", value: new Date(subscription.periodEnd) }] : [],
		{ lock },
	);
}

/**
 * Refunds a payment in full, through the journal (at most once per payment).
 */
export async function refundPayment(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
): Promise<void> {
	const gateway = gatewayFor(options);
	await runOperation(ctx.context, {
		kind: "create_refund",
		referenceId: subscription.referenceId,
		scope: `refund:${payment.id}`,
		reuseSucceeded: true,
		execute: (idempotencyKey) =>
			gateway.createRefund(
				payment.id,
				{
					amount: { currency: payment.amount.currency, value: payment.amount.value },
					description: "Refund of a subscription payment that could not be applied",
					metadata: { subscriptionId: subscription.id, operationKey: idempotencyKey },
				},
				idempotencyKey,
			),
		getId: (refund) => refund.id,
		recover: (idempotencyKey) => gateway.findRefundByOperationKey(payment.id, idempotencyKey),
	});
}

// ---------------------------------------------------------------------------
// Mollie subscriptions
// ---------------------------------------------------------------------------

/**
 * Creates a Mollie subscription that starts charging at `startAt`, through
 * the journal. Returns its id.
 */
export async function createScheduledSubscription(
	ctx: Ctx,
	options: MollieOptions,
	input: {
		subscription: Subscription;
		plan: MolliePlan;
		mandateId: string;
		startAt: Date;
		tax: TaxBreakdown | null;
		scope: string;
	},
): Promise<{ id: string; replayed: boolean }> {
	const { subscription, plan, mandateId, startAt, tax, scope } = input;
	const customerId = subscription.mollieCustomerId;
	if (!customerId) throw new Error(`Subscription ${subscription.id} has no Mollie customer`);
	const gateway = gatewayFor(options);
	const webhookUrl = getWebhookUrl(ctx, options);
	const operation = await runOperation(ctx.context, {
		kind: "create_subscription",
		referenceId: subscription.referenceId,
		scope,
		reuseSucceeded: true,
		execute: (idempotencyKey) =>
			gateway.createSubscription(
				customerId,
				{
					amount: { currency: planCurrency(plan), value: chargeAmount(plan, tax) },
					interval: plan.interval,
					description: subscriptionDescription(plan, subscription),
					startDate: toMollieDate(startAt),
					mandateId,
					webhookUrl,
					metadata: {
						subscriptionId: subscription.id,
						referenceId: subscription.referenceId,
						plan: plan.name.toLowerCase(),
						operationKey: idempotencyKey,
						...taxMetadata(tax),
					},
				},
				idempotencyKey,
			),
		getId: (created) => created.id,
		recover: (idempotencyKey, attempt) =>
			gateway.findSubscriptionByOperationKey(customerId, idempotencyKey, attempt.createdAt),
		compensate: async (mollieId) => {
			await gateway.cancelSubscription(customerId, mollieId, `compensate:${mollieId}`);
		},
	});
	return { id: operation.mollieId, replayed: operation.replayed };
}

function isEnded(subscription: { status?: string | null }): boolean {
	return subscription.status === "canceled" || subscription.status === "completed";
}

function isLive(subscription: { status?: string | null } | null): boolean {
	return subscription?.status === "active" || subscription?.status === "pending";
}

/**
 * Cancels the subscription's Mollie subscription through the journal. A
 * subscription that is already canceled (or gone) counts as success.
 */
export async function cancelMollieSubscription(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
): Promise<void> {
	const customerId = subscription.mollieCustomerId;
	const mollieSubscriptionId = subscription.mollieSubscriptionId;
	if (!customerId || !mollieSubscriptionId) return;
	const gateway = gatewayFor(options);
	const alreadyEnded = async () => {
		try {
			return isEnded(await gateway.getSubscription(customerId, mollieSubscriptionId));
		} catch (error) {
			if (isMollieNotFound(error)) return true;
			throw error;
		}
	};
	await runOperation(ctx.context, {
		kind: "cancel_subscription",
		referenceId: subscription.referenceId,
		scope: `cancel:${mollieSubscriptionId}`,
		reuseSucceeded: true,
		execute: async (idempotencyKey) => {
			try {
				return await gateway.cancelSubscription(customerId, mollieSubscriptionId, idempotencyKey);
			} catch (error) {
				if (isMollieApiError(error) && (await alreadyEnded())) return { id: mollieSubscriptionId };
				throw error;
			}
		},
		getId: () => mollieSubscriptionId,
		recover: async () => ((await alreadyEnded()) ? mollieSubscriptionId : null),
	});
}

/**
 * Brings the recent charges of the subscription's Mollie subscription up to
 * date locally: charges Mollie finished but whose webhook has not been
 * processed (e.g. a renewal paid a moment ago) are processed now, and their
 * hooks dispatched. Returns whether a charge is still in progress, and
 * whether anything was processed (the row may have changed).
 */
export async function settleRecentCharges(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	remoteId: string | null | undefined = subscription.mollieSubscriptionId,
	lock?: SubscriptionLock,
): Promise<{ inProgress: boolean; processed: boolean }> {
	const customerId = subscription.mollieCustomerId;
	if (!customerId || !remoteId) return { inProgress: false, processed: false };
	let recent: MolliePayment[];
	try {
		recent = await gatewayFor(options).listSubscriptionPayments(customerId, remoteId, 5);
	} catch (error) {
		if (isMollieNotFound(error)) return { inProgress: false, processed: false };
		throw error;
	}
	if (recent.some((p) => !isFinalPaymentStatus(p.status as string))) {
		return { inProgress: true, processed: false };
	}
	return { inProgress: false, processed: await processUnsettled(ctx, options, recent, lock) };
}

/**
 * Outcomes of a payment that is not paid whose consequence was not applied
 * yet (`applied`: a pro-rata charge a later upgrade recorded as applied).
 */
const UNHANDLED: readonly PaymentOutcome[] = ["pending", "applied"];

function isUnhandled(record: MolliePaymentRecord): boolean {
	return UNHANDLED.includes(record.outcome);
}

/** Whether a payment from Mollie still has to be processed locally. */
async function isUnsettled(ctx: Ctx, payment: MolliePayment): Promise<boolean> {
	const record = await findPaymentRecord(ctx, payment.id);
	if (record?.status !== payment.status) return true;
	if (payment.status === "paid")
		return record.outcome === "pending" || record.outcome === "duplicate";
	return isFinalPaymentStatus(payment.status as string) && isUnhandled(record);
}

async function processUnsettled(
	ctx: Ctx,
	options: MollieOptions,
	payments: MolliePayment[],
	lock: SubscriptionLock | undefined,
): Promise<boolean> {
	let processed = false;
	for (const payment of payments) {
		if (!(await isUnsettled(ctx, payment))) continue;
		const result = await processPayment(ctx, options, payment, { lock, reconcile: !lock });
		dispatchEvents(ctx, options, result.events);
		processed = true;
	}
	return processed;
}

/** How far back charges of a customer are looked for (SEPA can take days to settle). */
const DISCOVERY_DAYS = 35;

/**
 * Finds the customer's charges for this subscription that were never
 * processed: from any of its Mollie subscriptions (also canceled or stray
 * ones), pro-rata charges, recovery checkouts. They are found by their
 * metadata, so this does not depend on which Mollie subscription the row
 * still points at. Returns whether one is still in progress.
 */
export async function settleCustomerCharges(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	now: Date,
	lock?: SubscriptionLock,
): Promise<{ inProgress: boolean; processed: boolean }> {
	const customerId = subscription.mollieCustomerId;
	if (!customerId) return { inProgress: false, processed: false };
	const ours = (
		await gatewayFor(options).listRecentCustomerPayments(customerId, addDays(now, -DISCOVERY_DAYS))
	).filter(
		(payment) =>
			metadataOf(payment).subscriptionId === subscription.id ||
			(!!payment.subscriptionId && payment.subscriptionId === subscription.mollieSubscriptionId),
	);
	const inProgress = ours.some((payment) => !isFinalPaymentStatus(payment.status as string));
	const final = ours.filter((payment) => isFinalPaymentStatus(payment.status as string));
	return { inProgress, processed: await processUnsettled(ctx, options, final, lock) };
}

/** Mollie subscription creations for this row that may still be in flight. */
const CREATION_IN_FLIGHT_MS = 15 * 60 * 1000;

async function creationInFlight(ctx: Ctx, subscription: Subscription, now: Date) {
	const prefix = `remote:${subscription.id}:`;
	const pending = await ctx.context.adapter.findMany<{ idempotencyKey: string; createdAt: Date }>({
		model: "mollieOperation",
		where: [
			{ field: "referenceId", value: subscription.referenceId },
			{ field: "kind", value: "create_subscription" },
			{ field: "status", value: "pending" },
			{ field: "idempotencyKey", operator: "starts_with", value: prefix },
		],
		limit: 10,
	});
	return pending.some(
		(op) =>
			op.idempotencyKey.startsWith(prefix) &&
			now.getTime() - new Date(op.createdAt).getTime() < CREATION_IN_FLIGHT_MS,
	);
}

/** Cancels every running Mollie subscription tagged for this row; returns their ids. */
async function cancelTagged(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	lock: SubscriptionLock,
): Promise<string[]> {
	const customerId = subscription.mollieCustomerId as string;
	const canceled: string[] = [];
	for (const remote of await gatewayFor(options).listLiveCustomerSubscriptions(customerId)) {
		if (metadataOf(remote).subscriptionId !== subscription.id) continue;
		await lock.fence();
		await cancelMollieSubscription(ctx, options, {
			...subscription,
			mollieSubscriptionId: remote.id,
		});
		canceled.push(remote.id);
	}
	return canceled;
}

/**
 * Makes Mollie match the subscription row (the source of truth):
 *
 * - `trialing`/`active`/`past_due` and not canceling: exactly one running
 *   Mollie subscription for `pendingPlan ?? plan`, on the row's mandate, for
 *   the current amount (VAT included), not charging before `periodEnd`;
 * - canceling or ended: no running Mollie subscription for this row at all
 *   (including ones an interrupted change may have left).
 *
 * A mismatch (plan change, new mandate, changed VAT, restore, an interrupted
 * earlier attempt) is fixed by canceling the old Mollie subscription and
 * creating the right one, both through the journal:
 *
 * - charges of the old one that Mollie finished but that were not processed
 *   yet (a late webhook) are processed first, so the replacement starts after
 *   what they paid for; while one is still in progress, the change waits;
 * - Mollie subscriptions tagged for this row that it does not use are
 *   adopted if they are exactly right, and canceled otherwise;
 * - the replacement is only adopted if the row did not change meanwhile
 *   (e.g. a renewal extended the period); otherwise it is canceled and the
 *   reconcile starts over from the current row.
 *
 * Clears `mollieSyncNeeded` once Mollie matches the row as it was read.
 * Idempotent; the caller must hold the subscription's lock (see
 * `ensureRemote`).
 */
export async function reconcileRemote(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	now: Date,
	lock: SubscriptionLock,
	attempt = 0,
): Promise<Subscription> {
	const fence = lock.fence;
	const settled = (result: Subscription = subscription) =>
		markMollieSynced(ctx, subscription, result);
	const postpone = async () => {
		await flagMollieSync(ctx, subscription.id);
		return subscription;
	};
	const again = async (latest: Subscription | null) => {
		if (!latest || attempt >= 2) return postpone();
		return reconcileRemote(ctx, options, latest, now, lock, attempt + 1);
	};
	const customerId = subscription.mollieCustomerId;
	if (!customerId || subscription.status === "incomplete") return settled();
	// An unpaid subscription keeps its Mollie subscription (a later charge may
	// still succeed) unless it is being canceled.
	if (subscription.status === "unpaid" && !subscription.cancelAtPeriodEnd) return settled();
	const gateway = gatewayFor(options);
	let actual: MollieSubscription | null = null;
	if (subscription.mollieSubscriptionId) {
		try {
			actual = await gateway.getSubscription(customerId, subscription.mollieSubscriptionId);
		} catch (error) {
			if (!isMollieNotFound(error)) throw error;
		}
	}

	const wantsRemote =
		ACCESS_STATUSES.includes(subscription.status) &&
		!subscription.cancelAtPeriodEnd &&
		!!subscription.mollieMandateId;
	if (!wantsRemote) {
		if (isLive(actual)) {
			await fence();
			await cancelMollieSubscription(ctx, options, subscription);
		}
		const stopped = await cancelTagged(ctx, options, subscription, lock);
		// Billing is stopped. Charges those Mollie subscriptions made that were
		// never processed (no webhook) are processed now: a charge for a canceled
		// period is refunded. One still in progress is looked at again later, as
		// is a creation that is still in flight and could start billing.
		let pending = false;
		for (const remoteId of new Set([subscription.mollieSubscriptionId, ...stopped])) {
			if (!remoteId) continue;
			if ((await settleRecentCharges(ctx, options, subscription, remoteId, lock)).inProgress) {
				pending = true;
			}
		}
		// Also charges of Mollie subscriptions canceled earlier (no longer listed
		// as running) and other charges for this row.
		if ((await settleCustomerCharges(ctx, options, subscription, now, lock)).inProgress) {
			pending = true;
		}
		if (pending || (await creationInFlight(ctx, subscription, now))) return postpone();
		return settled();
	}

	const plan = await getPlanByName(options, subscription.pendingPlan ?? subscription.plan);
	if (!plan) {
		ctx.context.logger.error(`[mollie] Plan of ${subscription.id} is not configured`);
		return subscription;
	}
	const planName = plan.name.toLowerCase();
	const tax = await resolveTax(ctx, options, {
		referenceId: subscription.referenceId,
		customerType: await customerTypeOf(ctx, subscription),
		plan,
	});
	const amount = chargeAmount(plan, tax);
	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
	const paidThrough = periodEnd ? toMollieDate(periodEnd) : null;
	// While the period runs, the next charge is due when it ends; for monthly
	// intervals a few days absorb month-end differences (day and week
	// intervals are exact). A later date would leave time unpaid.
	const slackDays = parseInterval(plan.interval).unit === "month" ? MONTH_END_SLACK_DAYS : 0;
	const latestNextCharge =
		periodEnd && periodEnd > now ? toMollieDate(addDays(periodEnd, slackDays)) : null;
	const matches = (remote: MollieSubscription) =>
		isLive(remote) &&
		metadataOf(remote).plan === planName &&
		remote.mandateId === subscription.mollieMandateId &&
		remote.amount.value === amount &&
		remote.amount.currency === planCurrency(plan) &&
		remote.interval === plan.interval &&
		// Never charging for time that is already paid for...
		!(paidThrough && remote.nextPaymentDate && remote.nextPaymentDate < paidThrough) &&
		// ...nor skipping time that is not.
		!(latestNextCharge && remote.nextPaymentDate && remote.nextPaymentDate > latestNextCharge);
	if (actual && matches(actual)) return settled();

	if (actual) {
		const charges = await settleRecentCharges(
			ctx,
			options,
			subscription,
			subscription.mollieSubscriptionId,
			lock,
		);
		if (charges.inProgress) {
			ctx.context.logger.info(
				`[mollie] ${subscription.id}: waiting for a charge in progress before updating Mollie`,
			);
			return postpone();
		}
		if (charges.processed) return again(await reload(ctx, subscription.id));
	}
	if (isLive(actual)) {
		await fence();
		await cancelMollieSubscription(ctx, options, subscription);
	}

	const startAt = periodEnd && periodEnd > now ? periodEnd : ceilToUTCDate(now);
	let mollieSubscriptionId = "";
	for (const remote of await gateway.listLiveCustomerSubscriptions(customerId)) {
		if (remote.id === subscription.mollieSubscriptionId) continue;
		if (metadataOf(remote).subscriptionId !== subscription.id) continue;
		if (!mollieSubscriptionId && matches(remote) && remote.startDate === toMollieDate(startAt)) {
			mollieSubscriptionId = remote.id;
			continue;
		}
		await fence();
		await cancelMollieSubscription(ctx, options, {
			...subscription,
			mollieSubscriptionId: remote.id,
		});
	}

	const previous = subscription.mollieSubscriptionId ?? null;
	if (!mollieSubscriptionId) {
		const baseScope = `remote:${subscription.id}:${planName}:${toMollieDate(startAt)}:${subscription.mollieMandateId}:${amount}:${previous ?? "none"}`;
		// A reused earlier creation may have been canceled since (e.g. swept as
		// an orphan); then start a fresh attempt instead of adopting a dead one.
		for (let creation = 0, scope = baseScope; creation < 3; creation++) {
			await fence();
			const created = await createScheduledSubscription(ctx, options, {
				subscription,
				plan,
				mandateId: subscription.mollieMandateId as string,
				startAt,
				tax,
				scope,
			});
			mollieSubscriptionId = created.id;
			if (!created.replayed || isLive(await gateway.getSubscription(customerId, created.id))) break;
			scope = `${baseScope}:after:${created.id}`;
		}
	}
	await fence();
	// Only for the row as it was read: a change meanwhile (a renewal extending
	// the period, a recovery, a plan change) needs a different replacement.
	const adopted = await guardedUpdate(
		ctx,
		subscription.id,
		ACCESS_STATUSES,
		{ mollieSubscriptionId },
		[
			...(previous ? [{ field: "mollieSubscriptionId", value: previous }] : []),
			{ field: "mollieSyncRevision", value: subscription.mollieSyncRevision ?? 0 },
			...(periodEnd ? [{ field: "periodEnd", value: periodEnd }] : []),
		],
		{ lock },
	);
	if (adopted) return settled(adopted);
	const latest = await reload(ctx, subscription.id);
	if (latest?.mollieSubscriptionId === mollieSubscriptionId) return settled(latest);
	// This Mollie subscription was made for an outdated row: it must not charge.
	await cancelMollieSubscription(ctx, options, { ...subscription, mollieSubscriptionId });
	return again(latest);
}

/** Less than the shortest month interval, so a skipped month is always caught. */
const MONTH_END_SLACK_DAYS = 3;

/** Runs `reconcileRemote` under the subscription's lock. */
export async function ensureRemote(
	ctx: Ctx,
	options: MollieOptions,
	subscriptionId: string,
	now: Date = new Date(),
): Promise<Subscription | null> {
	if (!(await reload(ctx, subscriptionId))) return null;
	return withSubscriptionLock(ctx, subscriptionId, async (lock) => {
		const fresh = await reload(ctx, subscriptionId);
		return fresh ? reconcileRemote(ctx, options, fresh, now, lock) : null;
	});
}

/** `reconcileRemote` under a held lock for background paths: failures are left for the next sync. */
async function reconcileQuietly(
	ctx: Ctx,
	options: MollieOptions,
	subscriptionId: string,
	lock: SubscriptionLock,
): Promise<Subscription> {
	const fresh = await reload(ctx, subscriptionId);
	if (!fresh) throw new Error(`Subscription ${subscriptionId} disappeared`);
	try {
		return await reconcileRemote(ctx, options, fresh, new Date(), lock);
	} catch (error) {
		if (!(error instanceof OperationInProgressError)) {
			ctx.context.logger.error(
				`[mollie] Could not bring Mollie in line for ${subscriptionId}: ${errorMessage(error)}`,
			);
		}
		return (await reload(ctx, subscriptionId)) ?? fresh;
	}
}

/** Cheap local check: an active row without a Mollie subscription. */
function needsRemote(subscription: Subscription): boolean {
	return (
		ACCESS_STATUSES.includes(subscription.status) &&
		!subscription.cancelAtPeriodEnd &&
		!subscription.mollieSubscriptionId &&
		!!subscription.mollieMandateId
	);
}

/** Whether the journal holds our own cancellation of this Mollie subscription. */
async function canceledByUs(
	ctx: Ctx,
	subscription: Subscription,
	mollieSubscriptionId: string,
): Promise<boolean> {
	const prefix = `cancel:${mollieSubscriptionId}#`;
	const operations = await ctx.context.adapter.findMany<{ idempotencyKey: string; status: string }>(
		{
			model: "mollieOperation",
			where: [
				{ field: "referenceId", value: subscription.referenceId },
				{ field: "kind", value: "cancel_subscription" },
				{ field: "idempotencyKey", operator: "starts_with", value: prefix },
			],
			limit: 10,
		},
	);
	return operations.some((op) => op.idempotencyKey.startsWith(prefix) && op.status !== "failed");
}

/**
 * Applies the status of the subscription's Mollie subscription:
 * `suspended → past_due`; canceled/completed by Mollie (not by us) ends a
 * delinquent subscription now, and a paid-up one at the end of its period.
 */
export async function reconcileMollieSubscription(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	mollieSubscription: MollieSubscription,
): Promise<BillingEvent[]> {
	if (mollieSubscription.id !== subscription.mollieSubscriptionId) return [];
	const implied = mapMollieSubscriptionStatus(mollieSubscription.status as string);
	const sameRemote: Where[] = [{ field: "mollieSubscriptionId", value: mollieSubscription.id }];
	if (implied === "past_due") {
		await guardedUpdate(
			ctx,
			subscription.id,
			["trialing", "active"],
			{ status: "past_due" },
			sameRemote,
		);
		return [];
	}
	if (implied !== "canceled" || subscription.cancelAtPeriodEnd) return [];
	// Canceled by this plugin (e.g. the first step of replacing it), not by
	// Mollie or the merchant: `ensureRemote` finishes that replacement.
	if (await canceledByUs(ctx, subscription, mollieSubscription.id)) return [];
	if (subscription.status === "past_due" || subscription.status === "unpaid") {
		const canceled = await guardedUpdate(
			ctx,
			subscription.id,
			["past_due", "unpaid"],
			{ status: "canceled", pendingPlan: null },
			sameRemote,
			{ mollieSync: true },
		);
		if (!canceled) return [];
		const plan = await getPlanByName(options, canceled.plan);
		return [
			{ type: "subscription.canceled", subscription: canceled, plan, reason: "mollie_canceled" },
		];
	}
	if (subscription.status === "trialing" || subscription.status === "active") {
		await guardedUpdate(
			ctx,
			subscription.id,
			["trialing", "active"],
			{ cancelAtPeriodEnd: true, pendingPlan: null },
			sameRemote,
		);
	}
	return [];
}

// ---------------------------------------------------------------------------
// Time-based transitions and sync
// ---------------------------------------------------------------------------

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
): Promise<{ subscription: Subscription; events: BillingEvent[] }> {
	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
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
			{ mollieSync: true },
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
		);
		if (switched) return applyTimeTransitions(ctx, options, switched, now);
	}
	if (subscription.status === "past_due" && now >= addDays(periodEnd, gracePeriodDays(options))) {
		const unpaid = await guardedUpdate(ctx, subscription.id, ["past_due"], { status: "unpaid" }, [
			{ field: "periodEnd", value: periodEnd },
		]);
		return { subscription: unpaid ?? subscription, events: [] };
	}
	return { subscription, events: [] };
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
		await cancelMollieSubscription(ctx, options, {
			...subscription,
			mollieSubscriptionId: remote.id,
		});
	}
}

const PAGE_SIZE = 100;
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
	return found;
}

/**
 * Brings one subscription up to date with Mollie and the clock:
 *
 * - payments that are not final yet (open checkouts, a pro-rata charge
 *   whose webhook was missed), and paid payments whose outcome is not
 *   settled (not applied yet, or a refund still due) are (re)processed;
 * - clock-based transitions are applied;
 * - from one day before `periodEnd` (Mollie's next payment date), always
 *   for delinquent subscriptions, and whenever a change still has to reach
 *   Mollie (`mollieSyncNeeded`), Mollie is checked: subscription status,
 *   recent payments, orphans, and `ensureRemote` (plan, mandate, VAT).
 *   Other subscriptions are not fetched.
 */
export async function syncSubscription(
	ctx: Ctx,
	options: MollieOptions,
	initial: Subscription,
	now: Date,
): Promise<{ events: BillingEvent[]; checkedRemote: boolean }> {
	const gateway = gatewayFor(options);
	const events: BillingEvent[] = [];
	let checkedRemote = false;

	for (const record of await outstandingPayments(ctx, initial.id)) {
		checkedRemote = true;
		const result = await processPayment(
			ctx,
			options,
			await gateway.getPayment(record.molliePaymentId),
		);
		events.push(...result.events);
	}

	let subscription = (checkedRemote ? await reload(ctx, initial.id) : initial) ?? initial;
	if (subscription.status === "incomplete") {
		await expireCheckout(ctx, subscription);
		return { events, checkedRemote };
	}
	if (BILLING_STATUSES.includes(subscription.status)) {
		const timed = await applyTimeTransitions(ctx, options, subscription, now);
		events.push(...timed.events);
		subscription = timed.subscription;
	}
	if (!BILLING_STATUSES.includes(subscription.status)) {
		// Ended: make sure nothing at Mollie still bills it (e.g. a cancellation
		// that failed at Mollie, or a replacement whose creation was lost).
		if (subscription.mollieSyncNeeded) {
			checkedRemote = true;
			await ensureRemote(ctx, options, subscription.id, now);
		}
		return { events, checkedRemote };
	}
	const customerId = subscription.mollieCustomerId;
	if (!customerId) return { events, checkedRemote };

	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
	const stable =
		(subscription.status === "active" || subscription.status === "trialing") &&
		!subscription.mollieSyncNeeded;
	if (stable && periodEnd && now.getTime() < periodEnd.getTime() - DAY_MS) {
		return { events, checkedRemote };
	}

	checkedRemote = true;
	if (subscription.mollieSubscriptionId) {
		try {
			const mollieSubscription = await gateway.getSubscription(
				customerId,
				subscription.mollieSubscriptionId,
			);
			events.push(
				...(await reconcileMollieSubscription(ctx, options, subscription, mollieSubscription)),
			);
		} catch (error) {
			if (!isMollieNotFound(error)) throw error;
		}
		for (const payment of await gateway.listSubscriptionPayments(
			customerId,
			subscription.mollieSubscriptionId,
		)) {
			if (await isUnsettled(ctx, payment)) {
				events.push(...(await processPayment(ctx, options, payment)).events);
			}
		}
	}
	// Charges for this row by a stray or replaced Mollie subscription, or
	// pro-rata charges, whose webhook never arrived.
	await settleCustomerCharges(ctx, options, subscription, now);
	// First adopt or create the right Mollie subscription (this also finishes
	// an interrupted change), then cancel anything else tagged for this row.
	subscription = (await ensureRemote(ctx, options, subscription.id, now)) ?? subscription;
	await cancelOrphans(ctx, options, subscription, now);

	const grace = gracePeriodDays(options);
	if (
		(subscription.status === "active" || subscription.status === "trialing") &&
		!subscription.cancelAtPeriodEnd &&
		subscription.periodEnd &&
		now >= addDays(new Date(subscription.periodEnd), grace)
	) {
		// No paid renewal long after the period ended: treat as delinquent.
		subscription =
			(await guardedUpdate(ctx, subscription.id, ["trialing", "active"], { status: "past_due" })) ??
			subscription;
	}
	events.push(...(await applyTimeTransitions(ctx, options, subscription, now)).events);
	return { events, checkedRemote };
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
	for (const id of ids) {
		const subscription = await reload(ctx, id);
		if (!subscription) continue;
		result.checked++;
		try {
			const { events, checkedRemote } = await syncSubscription(ctx, options, subscription, now);
			if (checkedRemote) result.remoteChecked++;
			input.onEvents(events);
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
	);
	return result;
}
