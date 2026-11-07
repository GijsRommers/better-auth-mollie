import type { GenericEndpointContext, Where } from "better-auth";
import { type BillingEvent, dispatchEvents } from "./events";
import { gatewayFor, type MolliePayment, type MollieSubscription, metadataOf } from "./gateway";
import { type Fence, OperationInProgressError, runOperation, withLock } from "./operations";
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
	options: { mollieSync?: boolean } = {},
): Promise<Subscription | null> {
	return ctx.context.adapter.incrementOne<Subscription>({
		model: "subscription",
		where: [
			{ field: "id", value: id },
			{ field: "status", operator: "in", value: [...from] },
			...extra,
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
): Promise<MolliePaymentRecord | null> {
	return ctx.context.adapter.incrementOne<MolliePaymentRecord>({
		model: "molliePayment",
		where: [
			{ field: "molliePaymentId", value: molliePaymentId },
			{ field: "outcome", operator: "in", value: [...from] },
		],
		increment: {},
		set: { outcome: to },
	});
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
 * - hook events are emitted once per transition.
 */
export async function processPayment(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
): Promise<ProcessResult> {
	let subscription = await resolveSubscription(ctx, payment);
	if (!subscription) return { subscription: null, events: [], ignored: "unknown payment" };

	const recorded = await recordPayment(ctx, payment, subscription.id);
	let record = recorded.record;
	const purpose = paymentPurpose(payment);
	const status = payment.status as string;
	const events: BillingEvent[] = [];
	const duplicateEvents: BillingEvent[] = [];
	let activated = false;

	if (status === "paid" && record.outcome === "pending") {
		const result = await applyPaidPayment(ctx, options, subscription, payment, purpose);
		if (result.kind === "applied") {
			subscription = result.subscription;
			if (result.activated) {
				activated = true;
				const plan = await getPlanByName(options, subscription.plan);
				events.push({ type: "subscription.activated", subscription, plan, payment });
			}
			record = (await setOutcome(ctx, payment.id, ["pending"], "applied")) ?? record;
		} else {
			subscription = (await reload(ctx, subscription.id)) ?? subscription;
			if (subscription.appliedPaymentId === payment.id) {
				// Applied by a concurrent delivery of this same payment.
				record = (await setOutcome(ctx, payment.id, ["pending"], "applied")) ?? record;
			} else if (result.kind === "covered") {
				const classified = await classifyDuplicate(ctx, options, payment, subscription);
				record = classified.record ?? record;
				duplicateEvents.push(...classified.events);
			}
		}
	} else if (isFinalPaymentStatus(status) && status !== "paid") {
		if (purpose === "checkout" || purpose === "verification") {
			// Driven by the payment's state, not by who saw it change first, so
			// a crash right after recording the payment is repaired next time.
			subscription = (await expireCheckout(ctx, subscription)) ?? subscription;
		} else if (
			(purpose === "renewal" || purpose === "proration") &&
			isFailedPaymentStatus(status)
		) {
			subscription = (await applyFailedRenewal(ctx, subscription, payment)) ?? subscription;
		}
		// A failed recovery leaves the subscription as it was.
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
			events.push(...(await refundDuplicate(ctx, options, payment, subscription)));
		}
	}
	// A new mandate, a new start or a postponed change: bring Mollie in line.
	if (activated || subscription.mollieSyncNeeded || needsRemote(subscription)) {
		await ensureRemoteQuietly(ctx, options, subscription.id);
	}
	return { subscription, events };
}

async function applyPaidPayment(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
	purpose: PaymentPurpose,
): Promise<Application> {
	switch (purpose) {
		case "checkout":
		case "verification":
			return activateSubscription(ctx, options, subscription, payment);
		case "recovery":
			return recoverSubscription(ctx, options, subscription, payment);
		case "renewal":
			return applyRenewal(ctx, options, subscription, payment);
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
): Promise<{ record: MolliePaymentRecord | null; events: BillingEvent[] }> {
	const refund = refundsEnabled(options);
	const marked = await setOutcome(ctx, payment.id, ["pending"], refund ? "duplicate" : "kept");
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
): Promise<BillingEvent[]> {
	await refundPayment(ctx, options, subscription, payment);
	const refunded = await setOutcome(ctx, payment.id, ["duplicate"], "refunded");
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
			{ mollieSync: true },
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
			{ mollieSync: true },
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
async function expireCheckout(ctx: Ctx, subscription: Subscription): Promise<Subscription | null> {
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
	return guardedUpdate(ctx, subscription.id, ["incomplete"], { status: "incomplete_expired" });
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
		);
		if (updated) return { kind: "applied", subscription: updated, activated: false };
		subscription = await reload(ctx, subscription.id);
	}
	return subscription ? { kind: "unresolved" } : { kind: "covered" };
}

/**
 * A recurring payment failed: `trialing | active → past_due`, unless the
 * payment predates the current period (a later payment already succeeded) or
 * comes from a Mollie subscription that has been replaced. Guarded on the
 * period it checked, so a renewal that lands concurrently wins.
 */
async function applyFailedRenewal(
	ctx: Ctx,
	subscription: Subscription,
	payment: MolliePayment,
): Promise<Subscription | null> {
	if (subscription.status !== "trialing" && subscription.status !== "active") return null;
	if (subscription.cancelAtPeriodEnd) return null;
	if (payment.subscriptionId && payment.subscriptionId !== subscription.mollieSubscriptionId) {
		return null;
	}
	const createdAt = new Date(payment.createdAt);
	if (subscription.periodStart && createdAt < new Date(subscription.periodStart)) return null;
	return guardedUpdate(
		ctx,
		subscription.id,
		["trialing", "active"],
		{ status: "past_due" },
		subscription.periodEnd ? [{ field: "periodEnd", value: new Date(subscription.periodEnd) }] : [],
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
	let processed = false;
	for (const payment of recent) {
		const record = await findPaymentRecord(ctx, payment.id);
		const settled =
			record?.status === payment.status &&
			(payment.status !== "paid" || record.outcome !== "pending");
		if (settled) continue;
		const result = await processPayment(ctx, options, payment);
		dispatchEvents(ctx, options, result.events);
		processed = true;
	}
	return { inProgress: false, processed };
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
	fence: Fence,
): Promise<string[]> {
	const customerId = subscription.mollieCustomerId as string;
	const canceled: string[] = [];
	for (const remote of await gatewayFor(options).listLiveCustomerSubscriptions(customerId)) {
		if (metadataOf(remote).subscriptionId !== subscription.id) continue;
		await fence();
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
	now: Date = new Date(),
	fence: Fence = async () => {},
	attempt = 0,
): Promise<Subscription> {
	const settled = (result: Subscription = subscription) =>
		markMollieSynced(ctx, subscription, result);
	const postpone = async () => {
		await flagMollieSync(ctx, subscription.id);
		return subscription;
	};
	const again = async (latest: Subscription | null) => {
		if (!latest || attempt >= 2) return postpone();
		return reconcileRemote(ctx, options, latest, now, fence, attempt + 1);
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
		const stopped = await cancelTagged(ctx, options, subscription, fence);
		// Billing is stopped. Charges those Mollie subscriptions made that were
		// never processed (no webhook) are processed now: a charge for a canceled
		// period is refunded. One still in progress is looked at again later, as
		// is a creation that is still in flight and could start billing.
		let pending = false;
		for (const remoteId of new Set([subscription.mollieSubscriptionId, ...stopped])) {
			if (!remoteId) continue;
			if ((await settleRecentCharges(ctx, options, subscription, remoteId)).inProgress) {
				pending = true;
			}
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
	const matches = (remote: MollieSubscription) =>
		isLive(remote) &&
		metadataOf(remote).plan === planName &&
		remote.mandateId === subscription.mollieMandateId &&
		remote.amount.value === amount &&
		remote.amount.currency === planCurrency(plan) &&
		remote.interval === plan.interval &&
		// Never charging for time that is already paid for.
		!(paidThrough && remote.nextPaymentDate && remote.nextPaymentDate < paidThrough);
	if (actual && matches(actual)) return settled();

	if (actual) {
		const charges = await settleRecentCharges(ctx, options, subscription);
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
	);
	if (adopted) return settled(adopted);
	const latest = await reload(ctx, subscription.id);
	if (latest?.mollieSubscriptionId === mollieSubscriptionId) return settled(latest);
	// This Mollie subscription was made for an outdated row: it must not charge.
	await cancelMollieSubscription(ctx, options, { ...subscription, mollieSubscriptionId });
	return again(latest);
}

/** Runs `reconcileRemote` under the subscription's lock. */
export async function ensureRemote(
	ctx: Ctx,
	options: MollieOptions,
	subscriptionId: string,
	now: Date = new Date(),
): Promise<Subscription | null> {
	const initial = await reload(ctx, subscriptionId);
	if (!initial) return null;
	return withLock(
		ctx.context,
		{ key: `lock:subscription:${subscriptionId}`, referenceId: initial.referenceId },
		async (fence) => {
			const fresh = await reload(ctx, subscriptionId);
			return fresh ? reconcileRemote(ctx, options, fresh, now, fence) : null;
		},
	);
}

/** `ensureRemote` for background paths: failures are left for the next sync. */
async function ensureRemoteQuietly(ctx: Ctx, options: MollieOptions, subscriptionId: string) {
	try {
		await ensureRemote(ctx, options, subscriptionId);
	} catch (error) {
		if (error instanceof OperationInProgressError) return;
		ctx.context.logger.error(
			`[mollie] Could not bring Mollie in line for ${subscriptionId}: ${errorMessage(error)}`,
		);
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
 * Payment records that still need processing: not final yet (only when
 * `subscriptionId` is given), or paid without a settled outcome.
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
	];
	if (subscriptionId) {
		queries.unshift([
			...scope,
			{ field: "status", operator: "in", value: [...UNRESOLVED_PAYMENT_STATUSES] },
		]);
	}
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
			events.push(...(await processPayment(ctx, options, payment)).events);
		}
	}
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
