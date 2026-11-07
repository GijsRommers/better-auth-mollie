import type { GenericEndpointContext as Ctx, Where } from "better-auth";
import { type BillingEvent, dispatchEvents } from "./events";
import { gatewayFor, type MolliePayment, type MollieSubscription, metadataOf } from "./gateway";
import { coverage, withReferenceLock } from "./identity";
import { type SubscriptionLock, withSubscriptionLock } from "./lock";
import { OperationInProgressError } from "./operations";
import {
	cancelMollieSubscription,
	createScheduledSubscription,
	findRemote,
	isLive,
	refundPayment,
} from "./remote";
import {
	claimPayment,
	customerTypeOf,
	findPaymentRecord,
	findSubscription,
	flagMollieSync,
	guardedUpdate,
	isUnhandled,
	lockWaitMs,
	markMollieSynced,
	periodEndOf,
	reload,
	sameAppliedPayment,
	sameDate,
	setOutcome,
	settlePreviousPayment,
	UNHANDLED,
} from "./rows";
import {
	ACCESS_STATUSES,
	BILLING_STATUSES,
	canAdvancePayment,
	isFailedPaymentStatus,
	isFinalPaymentStatus,
} from "./status";
import { chargeAmount, fromCents, resolveTax, toCents, trustedTax } from "./tax";
import type {
	MollieOperation,
	MollieOptions,
	MolliePaymentRecord,
	MolliePlan,
	PaymentHookData,
	PaymentPurpose,
	Subscription,
} from "./types";
import {
	addDays,
	addInterval,
	billingCycle,
	CHARGE_DATE_SLACK_MS,
	ceilToUTCDate,
	DAY_MS,
	errorMessage,
	fromMollieDate,
	getPlanByName,
	isMollieNotFound,
	parseInterval,
	planCurrency,
	toDate,
	toMollieDate,
} from "./utils";

/**
 * Payments and what they do to a subscription (activation, recovery,
 * renewal, failure, duplicates), and `reconcileRemote`, which makes Mollie
 * match the row afterwards. The two call each other: processing a payment
 * may change what Mollie should bill, and bringing Mollie in line first
 * processes the charges it already made.
 */

export type ProcessResult = {
	subscription: Subscription | null;
	events: BillingEvent[];
	/** Set when the payment does not belong to any local subscription. */
	ignored?: string | undefined;
};

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
 * Records a payment idempotently: the row is created, or its status moved
 * forward (never back). Safe to call from any number of processes.
 */
export async function recordPayment(
	ctx: Ctx,
	payment: MolliePayment,
	subscriptionId: string,
): Promise<void> {
	const { adapter } = ctx.context;
	const where: Where[] = [{ field: "molliePaymentId", value: payment.id }];
	const status = payment.status as MolliePaymentRecord["status"];
	const timestamps = {
		paidAt: toDate(payment.paidAt),
		failedAt: status === "paid" ? null : terminalTimestamp(payment),
	};
	// Recorded with the change itself, so whoever ends up processing the
	// payment (not necessarily this caller) dispatches its hooks.
	const hooksDue = status === "paid" || isFailedPaymentStatus(status);
	let existing = await adapter.findOne<MolliePaymentRecord>({ model: "molliePayment", where });
	if (!existing) {
		try {
			await adapter.create<Omit<MolliePaymentRecord, "id">, MolliePaymentRecord>({
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
					hooksDue,
					...timestamps,
				},
			});
			return;
		} catch (error) {
			// Unique molliePaymentId: someone else recorded it first.
			existing = await adapter.findOne<MolliePaymentRecord>({ model: "molliePayment", where });
			if (!existing) throw error;
		}
	}
	if (!canAdvancePayment(existing.status, status)) return;
	// Guarded on the status that was read: a concurrent recorder that moved it
	// further wins, and this call then changes nothing.
	await adapter.incrementOne<MolliePaymentRecord>({
		model: "molliePayment",
		where: [...where, { field: "status", value: existing.status }],
		increment: {},
		set: { status, ...timestamps, ...(hooksDue ? { hooksDue: true } : {}) },
	});
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
		{ waitMs: lockWaitMs(options) },
	);
}

async function applyPayment(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
	initial: Subscription,
	lock: SubscriptionLock,
	reconcile: boolean,
): Promise<ProcessResult> {
	let subscription = initial;
	await recordPayment(ctx, payment, subscription.id);
	let record = await claimPayment(ctx, payment.id, lock);
	const claim = lock.serial;
	const purpose = paymentPurpose(payment);
	const status = payment.status;
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
			record =
				(await setOutcome(ctx, payment.id, ["pending"], "applied", claim, {
					paidThrough: paidThroughOf(purpose, subscription),
				})) ?? record;
		} else {
			subscription = (await reload(ctx, subscription.id)) ?? subscription;
			if (subscription.appliedPaymentId === payment.id) {
				// Applied by a concurrent delivery of this same payment.
				record =
					(await setOutcome(ctx, payment.id, ["pending"], "applied", claim, {
						paidThrough: paidThroughOf(purpose, subscription),
					})) ?? record;
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

	// Hooks after the decision, by the current claimant that clears them as
	// due: once per payment, also if an earlier delivery recorded the change
	// and then stopped or was told to come back.
	if (status === "paid" || isFailedPaymentStatus(status)) {
		const delivered = await ctx.context.adapter.incrementOne<MolliePaymentRecord>({
			model: "molliePayment",
			where: [
				{ field: "molliePaymentId", value: payment.id },
				{ field: "hooksDue", value: true },
				{ field: "status", value: status },
				{ field: "claimSerial", value: claim },
			],
			increment: {},
			set: { hooksDue: false },
		});
		if (delivered) {
			const latest = (await reload(ctx, subscription.id)) ?? subscription;
			const data = await paymentHookData(options, payment, delivered, latest);
			events.push({ type: status === "paid" ? "payment.paid" : "payment.failed", data });
		}
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
				if (error instanceof OperationInProgressError) {
					ctx.context.logger.info(`[mollie] Refund of ${payment.id} is in progress`);
				} else {
					ctx.context.logger.error(
						`[mollie] Refund of ${payment.id} failed; the next sync retries it: ${errorMessage(error)}`,
					);
				}
			}
		}
	}
	if (status === "paid") {
		const chargeback = await settleChargeback(ctx, options, payment, subscription, lock, claim);
		subscription = chargeback.subscription;
		events.push(...chargeback.events);
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
	// Nothing left to refund (e.g. charged back): the money is back already.
	const remaining = payment.amountRemaining;
	if (!remaining || toCents(remaining.value) > 0) {
		await refundPayment(ctx, options, subscription, payment);
	}
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

/** The end of the period a payment paid for, recorded when it applies. */
function paidThroughOf(purpose: PaymentPurpose, subscription: Subscription): Date | null {
	return purpose === "proration" ? null : periodEndOf(subscription);
}

/**
 * Follows the amount charged back on a paid payment (a card dispute, or a
 * reversed SEPA Direct Debit). When it changes, the consequence is applied
 * first and the new amount recorded after, by the current claimant only;
 * whoever then clears the hook as due dispatches `onChargeback`, once per
 * change. A stop in between is repaired by the next delivery or sync.
 */
async function settleChargeback(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
	initial: Subscription,
	lock: SubscriptionLock,
	claim: number,
): Promise<{ subscription: Subscription; events: BillingEvent[] }> {
	let subscription = initial;
	let record = await findPaymentRecord(ctx, payment.id);
	if (!record) return { subscription, events: [] };
	const recorded = record.amountChargedBack ? toCents(record.amountChargedBack) : 0;
	const reported = payment.amountChargedBack ? toCents(payment.amountChargedBack.value) : 0;
	if (reported > 0 || recorded > 0) {
		// Mollie's total may still count reversed chargebacks; these do not.
		const cents = await gatewayFor(options).chargedBackCents(payment.id);
		if (cents !== recorded) {
			if (recorded === 0) {
				subscription =
					(await chargeBackPeriod(ctx, options, subscription, payment, record, lock)) ??
					subscription;
			}
			await lock.fence();
			record =
				(await ctx.context.adapter.incrementOne<MolliePaymentRecord>({
					model: "molliePayment",
					where: [
						{ field: "molliePaymentId", value: payment.id },
						{ field: "amountChargedBack", value: record.amountChargedBack ?? null },
						{ field: "claimSerial", value: claim },
					],
					increment: {},
					set: {
						amountChargedBack: cents > 0 ? fromCents(cents) : null,
						chargebackDue: true,
						// Looked at again daily for a reversal; not after one.
						chargebackCheckedAt: cents > 0 ? new Date() : null,
					},
				})) ?? record;
		}
	}
	if (!record.chargebackDue) return { subscription, events: [] };
	const delivered = await ctx.context.adapter.incrementOne<MolliePaymentRecord>({
		model: "molliePayment",
		where: [
			{ field: "molliePaymentId", value: payment.id },
			{ field: "chargebackDue", value: true },
			{ field: "claimSerial", value: claim },
		],
		increment: {},
		set: { chargebackDue: false },
	});
	if (!delivered) return { subscription, events: [] };
	subscription = (await reload(ctx, subscription.id)) ?? subscription;
	const amount = delivered.amountChargedBack ?? "0.00";
	return {
		subscription,
		events: [
			{
				type: "payment.chargeback",
				data: {
					...(await paymentHookData(options, payment, delivered, subscription)),
					chargeback: {
						amount: { currency: payment.amount.currency, value: amount },
						reversed: toCents(amount) === 0,
					},
				},
			},
		],
	};
}

/**
 * A new chargeback. When it took back the payment for the period that is
 * running, that period counts as unpaid, as if its charge had failed:
 * `past_due`, paid only up to the period's start, so the grace period counts
 * from there. A charged-back pro-rata charge is judged like a failed one
 * (also one of an earlier upgrade in the same period). A chargeback of an
 * earlier period's payment (also the last paid one, after a failed renewal),
 * or of a trial's verification payment, changes nothing; the hook reports it.
 */
async function chargeBackPeriod(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
	record: MolliePaymentRecord,
	lock: SubscriptionLock,
): Promise<Subscription | null> {
	if (record.outcome !== "applied") return null;
	const purpose = paymentPurpose(payment);
	if (purpose === "verification") return null;
	// Applied, so it paid for an upgrade; one of an earlier period is left alone there.
	if (purpose === "proration") return applyFailedRenewal(ctx, options, subscription, payment, lock);
	if (!BILLING_STATUSES.includes(subscription.status)) return null;
	const periodEnd = periodEndOf(subscription);
	const periodStart = subscription.periodStart ? new Date(subscription.periodStart) : null;
	if (!periodEnd || !periodStart || periodEnd.getTime() <= Date.now()) return null;
	// Recorded when it applied; for older records, the payment applied last.
	const paidCurrentPeriod = record.paidThrough
		? new Date(record.paidThrough).getTime() === periodEnd.getTime()
		: subscription.appliedPaymentId === payment.id;
	if (!paidCurrentPeriod) return null;
	// A pending cancellation then ends it right away; unpaid stays unpaid.
	const status =
		subscription.cancelAtPeriodEnd || subscription.status === "unpaid"
			? subscription.status
			: "past_due";
	return guardedUpdate(
		ctx,
		subscription.id,
		BILLING_STATUSES,
		{ status, periodEnd: periodStart },
		[...sameDate("periodEnd", periodEnd), ...sameDate("periodStart", periodStart)],
		{ lock },
	);
}

/**
 * First payment paid: move `incomplete → trialing | active` with the new
 * mandate and the plan that was paid for. The Mollie subscription is created
 * afterwards by `reconcileRemote`. Only one payment can win the guarded update;
 * a paid first payment for a row that is no longer `incomplete` is covered.
 */
async function activateSubscription(
	ctx: Ctx,
	options: MollieOptions,
	initial: Subscription,
	payment: MolliePayment,
	lock: SubscriptionLock,
): Promise<Application> {
	// No longer pending (activated by another payment, expired, ended): this
	// payment pays for nothing, whatever its plan or other rows are doing.
	if (initial.status !== "incomplete") return { kind: "covered" };
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
	// An identity has one billing subscription: a checkout paid while another
	// one still covers it (e.g. two tabs, or a second pending row) pays for
	// nothing, so it is refunded rather than starting a second subscription.
	// Checked and applied under the identity's lock, so two pending rows
	// activated at the same time cannot both pass.
	const identity = { referenceId: initial.referenceId, customerType: initial.customerType ?? null };
	return withReferenceLock(ctx, options, identity, async (fence): Promise<Application> => {
		const covered = await coverage(ctx, options, identity, initial.id, new Date());
		if (covered === "covered") return { kind: "covered" };
		// Another row is being changed right now: come back shortly (409).
		if (covered === "busy") throw new OperationInProgressError(`activate:${initial.id}`);
		await fence();
		const result = await activateRow(ctx, initial, payment, plan, customerId, anchor, lock, {
			isTrial,
			trialEnd,
			periodEnd,
		});
		return result;
	});
}

async function activateRow(
	ctx: Ctx,
	initial: Subscription,
	payment: MolliePayment,
	plan: MolliePlan,
	customerId: string,
	anchor: Date,
	lock: SubscriptionLock,
	period: { isTrial: boolean; trialEnd: Date | null; periodEnd: Date },
): Promise<Application> {
	const { isTrial, trialEnd, periodEnd } = period;
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
 * one. `reconcileRemote` then moves billing to the new mandate.
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
				...(periodStart ? [...sameDate("periodStart", periodStart)] : []),
				...sameAppliedPayment(subscription),
			],
			{ mollieSync: true, lock },
		);
		if (updated) return { kind: "applied", subscription: updated, activated: true };
		subscription = await reload(ctx, subscription.id);
	}
	return subscription ? { kind: "unresolved" } : { kind: "covered" };
}

/** A pending row without any checkout attempt is expired after this. */
const ABANDONED_ROW_MS = 24 * 60 * 60 * 1000;

/** Journal scope prefix of the checkouts (first payments) created for a row. */
export function checkoutScope(purpose: PaymentPurpose, subscriptionId: string): string {
	return `${purpose === "recovery" ? "recovery" : "first-payment"}:${subscriptionId}:`;
}

/** Whether the row, or the latest attempt to create its checkout, is less than a day old. */
async function startedRecently(ctx: Ctx, subscription: Subscription): Promise<boolean> {
	const since = new Date(Date.now() - ABANDONED_ROW_MS);
	if (new Date(subscription.createdAt) > since) return true;
	const prefix = checkoutScope("checkout", subscription.id);
	for (let offset = 0; ; offset += ATTEMPTS_PAGE) {
		const page = await ctx.context.adapter.findMany<MollieOperation>({
			model: "mollieOperation",
			where: [
				{ field: "referenceId", value: subscription.referenceId },
				{ field: "kind", value: "create_first_payment" },
				// SQL adapters may over-match this (an unescaped LIKE), so every
				// page is filtered, and paging goes on until one matches.
				{ field: "idempotencyKey", operator: "starts_with", value: prefix },
				{ field: "createdAt", operator: "gt", value: since },
			],
			sortBy: { field: "idempotencyKey", direction: "asc" },
			limit: ATTEMPTS_PAGE,
			offset,
		});
		if (page.some((op) => op.idempotencyKey.startsWith(prefix))) return true;
		if (page.length < ATTEMPTS_PAGE) return false;
	}
}

const ATTEMPTS_PAGE = 100;

/**
 * A first payment failed, expired or was canceled. The checkout is over
 * unless another attempt for this subscription is still open or paid.
 */
export async function expireCheckout(
	ctx: Ctx,
	subscription: Subscription,
	lock: SubscriptionLock,
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
	// No attempt at all: a checkout whose creation failed, or is still on its
	// way. A day after the row and its latest creation attempt, it is expired.
	if (attempts.length === 0 && (await startedRecently(ctx, subscription))) return null;
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
			const createdAt = new Date(payment.createdAt);
			const remote = await findRemote(options, customerId, remoteId);
			if (remote) {
				cycle = billingCycle(fromMollieDate(remote.startDate), remote.interval, createdAt);
			} else {
				// Gone at Mollie: it pays the cycle that follows what is paid for.
				const paidThrough = periodEndOf(subscription);
				const plan = await getPlanByName(
					options,
					typeof billedPlan === "string"
						? billedPlan
						: (subscription.pendingPlan ?? subscription.plan),
				);
				if (!paidThrough || !plan) return { kind: "unresolved" };
				if (createdAt.getTime() < paidThrough.getTime() - CHARGE_DATE_SLACK_MS) {
					return { kind: "covered" };
				}
				cycle = billingCycle(paidThrough, plan.interval, createdAt);
			}
		}
		const currentEnd = periodEndOf(subscription);
		if (
			currentEnd &&
			(cycle.end <= currentEnd || cycle.start.getTime() < currentEnd.getTime() - DAY_MS)
		) {
			return { kind: "covered" };
		}
		// The first charge of a scheduled plan change: that plan is now active.
		const pendingPlan = subscription.pendingPlan;
		const switchPlan = !!pendingPlan && billedPlan === pendingPlan;
		const guards: Where[] = [
			{ field: "mollieSubscriptionId", value: remoteId },
			{ field: "cancelAtPeriodEnd", value: false },
			...sameAppliedPayment(subscription),
		];
		if (currentEnd) guards.push(...sameDate("periodEnd", currentEnd));
		if (switchPlan) guards.push({ field: "pendingPlan", value: pendingPlan });
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
				...(switchPlan ? { plan: pendingPlan, pendingPlan: null } : {}),
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
	const periodEnd = periodEndOf(subscription);
	if (payment.subscriptionId) {
		if (payment.subscriptionId !== subscription.mollieSubscriptionId) return null;
		const customerId = payment.customerId ?? subscription.mollieCustomerId;
		if (!customerId) return null;
		// Gone at Mollie: judged like a standalone charge below.
		const remote = await findRemote(options, customerId, payment.subscriptionId);
		if (remote) {
			const cycle = billingCycle(fromMollieDate(remote.startDate), remote.interval, createdAt);
			if (periodEnd && cycle.end <= periodEnd) return null;
		} else if (periodEnd && createdAt.getTime() < periodEnd.getTime() - CHARGE_DATE_SLACK_MS) {
			// Gone at Mollie: a charge from before the paid-through date was for a
			// cycle that is paid.
			return null;
		}
	} else if (subscription.periodStart && createdAt < new Date(subscription.periodStart)) {
		return null;
	}
	return guardedUpdate(
		ctx,
		subscription.id,
		["trialing", "active"],
		{ status: "past_due" },
		subscription.periodEnd ? [...sameDate("periodEnd", new Date(subscription.periodEnd))] : [],
		{ lock },
	);
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
	how: SettleOptions = {},
): Promise<Settlement> {
	const remoteId = how.remoteId === undefined ? subscription.mollieSubscriptionId : how.remoteId;
	const customerId = subscription.mollieCustomerId;
	const nothing: Settlement = { inProgress: false, processed: false, errors: [] };
	if (!customerId || !remoteId) return nothing;
	let recent: MolliePayment[];
	try {
		recent = await gatewayFor(options).listSubscriptionPayments(customerId, remoteId, 5);
	} catch (error) {
		if (isMollieNotFound(error)) return nothing;
		throw error;
	}
	if (recent.some((p) => !isFinalPaymentStatus(p.status))) {
		return { ...nothing, inProgress: true };
	}
	return processUnsettled(ctx, options, recent, how);
}

/**
 * How charges are settled: of which Mollie subscription (default: the
 * row's), under a lock the caller holds, and whether processing a payment
 * may also bring Mollie in line (default: when no lock is held).
 */
export type SettleOptions = {
	remoteId?: string | null | undefined;
	lock?: SubscriptionLock | undefined;
	reconcile?: boolean | undefined;
};

/** Whether a payment from Mollie still has to be processed locally. */
async function isUnsettled(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
): Promise<boolean> {
	const record = await findPaymentRecord(ctx, payment.id);
	if (record?.status !== payment.status) return true;
	if (record.hooksDue || record.chargebackDue) return true;
	if (payment.status === "paid") {
		if (record.outcome === "pending" || record.outcome === "duplicate") return true;
		// A chargeback (or its reversal) not processed yet. Mollie's total may
		// still count reversed chargebacks, so a difference is confirmed with
		// the amount that is actually charged back.
		const reported = payment.amountChargedBack ? toCents(payment.amountChargedBack.value) : 0;
		const recorded = record.amountChargedBack ? toCents(record.amountChargedBack) : 0;
		if (reported === recorded) return false;
		return (await gatewayFor(options).chargedBackCents(payment.id)) !== recorded;
	}
	return isFinalPaymentStatus(payment.status) && isUnhandled(record);
}

async function processUnsettled(
	ctx: Ctx,
	options: MollieOptions,
	payments: MolliePayment[],
	how: SettleOptions,
): Promise<Settlement> {
	const { lock } = how;
	const reconcile = how.reconcile ?? !lock;
	const settlement: Settlement = { inProgress: false, processed: false, errors: [] };
	for (const payment of payments) {
		// Each payment on its own: one that cannot be looked at or processed
		// now does not stop the others. It stays outstanding (and counts as in
		// progress).
		try {
			if (!(await isUnsettled(ctx, options, payment))) continue;
			const result = await processPayment(ctx, options, payment, { lock, reconcile });
			dispatchEvents(ctx, options, result.events);
			settlement.processed = true;
		} catch (error) {
			settlement.inProgress = true;
			if (!(error instanceof OperationInProgressError)) {
				settlement.errors.push(`${payment.id}: ${errorMessage(error)}`);
			}
		}
	}
	return settlement;
}

/**
 * Result of bringing charges up to date: whether one is still in progress
 * (or could not be processed now), whether anything was processed, and the
 * errors of payments that could not be processed.
 */
export type Settlement = { inProgress: boolean; processed: boolean; errors: string[] };

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
	how: SettleOptions = {},
): Promise<Settlement> {
	const customerId = subscription.mollieCustomerId;
	if (!customerId) return { inProgress: false, processed: false, errors: [] };
	const ours = (
		await gatewayFor(options).listRecentCustomerPayments(customerId, addDays(now, -DISCOVERY_DAYS))
	).filter(
		(payment) =>
			metadataOf(payment).subscriptionId === subscription.id ||
			(!!payment.subscriptionId && payment.subscriptionId === subscription.mollieSubscriptionId),
	);
	const inProgress = ours.some((payment) => !isFinalPaymentStatus(payment.status));
	const final = ours.filter((payment) => isFinalPaymentStatus(payment.status));
	const settlement = await processUnsettled(ctx, options, final, how);
	return { ...settlement, inProgress: settlement.inProgress || inProgress };
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
	customerId: string,
	lock: SubscriptionLock,
): Promise<string[]> {
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

/** Less than the shortest month interval, so a skipped month is always caught. */
const MONTH_END_SLACK_DAYS = 3;

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
 * Idempotent; the caller must hold the subscription's lock (as
 * `processPayment`, `syncSubscription` and the subscription endpoints do).
 */
export async function reconcileRemote(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	now: Date,
	lock: SubscriptionLock,
	extra: { attempt?: number; charges?: Settlement | undefined } = {},
): Promise<Subscription> {
	const fence = lock.fence;
	const attempt = extra.attempt ?? 0;
	const settled = (result: Subscription = subscription) =>
		markMollieSynced(ctx, subscription, result, lock);
	const postpone = async () => {
		await flagMollieSync(ctx, subscription.id, lock);
		return subscription;
	};
	const again = async (latest: Subscription | null) => {
		if (!latest || attempt >= 2) return postpone();
		return reconcileRemote(ctx, options, latest, now, lock, { attempt: attempt + 1 });
	};
	const customerId = subscription.mollieCustomerId;
	if (!customerId || subscription.status === "incomplete") return settled();
	// An unpaid subscription keeps its Mollie subscription (a later charge may
	// still succeed) unless it is being canceled.
	if (subscription.status === "unpaid" && !subscription.cancelAtPeriodEnd) return settled();
	const gateway = gatewayFor(options);
	const actual = subscription.mollieSubscriptionId
		? await findRemote(options, customerId, subscription.mollieSubscriptionId)
		: null;

	const mandateId = subscription.mollieMandateId;
	const wantsRemote =
		ACCESS_STATUSES.includes(subscription.status) && !subscription.cancelAtPeriodEnd && !!mandateId;
	if (!wantsRemote || !mandateId) {
		if (isLive(actual)) {
			await fence();
			await cancelMollieSubscription(ctx, options, subscription);
		}
		const stopped = await cancelTagged(ctx, options, subscription, customerId, lock);
		// Billing is stopped. Charges those Mollie subscriptions made that were
		// never processed (no webhook) are processed now: a charge for a canceled
		// period is refunded. One still in progress is looked at again later, as
		// is a creation that is still in flight and could start billing.
		let pending = false;
		for (const remoteId of new Set([subscription.mollieSubscriptionId, ...stopped])) {
			if (!remoteId) continue;
			if ((await settleRecentCharges(ctx, options, subscription, { remoteId, lock })).inProgress) {
				pending = true;
			}
		}
		// Also charges of Mollie subscriptions canceled earlier (no longer listed
		// as running) and other charges for this row, unless the caller just
		// looked them up (the sync does, before taking the lock).
		const charges =
			extra.charges ?? (await settleCustomerCharges(ctx, options, subscription, now, { lock }));
		if (charges.inProgress) pending = true;
		if (pending || (await creationInFlight(ctx, subscription, now))) return postpone();
		return settled();
	}

	const wanted = subscription.pendingPlan ?? subscription.plan;
	const plan = await getPlanByName(options, wanted);
	// Reported (the sync lists it in its errors); Mollie keeps billing as it was.
	if (!plan) throw new Error(`Plan "${wanted}" of ${subscription.id} is not configured`);
	const planName = plan.name.toLowerCase();
	const tax = await resolveTax(ctx, options, {
		referenceId: subscription.referenceId,
		customerType: await customerTypeOf(ctx, subscription),
		plan,
	});
	const amount = chargeAmount(plan, tax);
	const periodEnd = periodEndOf(subscription);
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
		const charges = await settleRecentCharges(ctx, options, subscription, { lock });
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
		// A mandate Mollie no longer accepts (the usual reason it suspends a
		// subscription) cannot bill anything new: wait for a recovery payment,
		// which brings a new mandate, instead of failing to create on it again.
		if (!(await mandateUsable(options, customerId, mandateId))) {
			ctx.context.logger.warn(
				`[mollie] ${subscription.id}: mandate ${mandateId} is no longer valid; billing resumes after a recovery payment`,
			);
			return settled();
		}
		const baseScope = `remote:${subscription.id}:${planName}:${toMollieDate(startAt)}:${subscription.mollieMandateId}:${amount}:${previous ?? "none"}`;
		// A reused earlier creation may have been canceled since (e.g. swept as
		// an orphan); then start a fresh attempt instead of adopting a dead one.
		for (let creation = 0, scope = baseScope; creation < 3; creation++) {
			await fence();
			const created = await createScheduledSubscription(ctx, options, {
				subscription,
				plan,
				mandateId,
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
			...(periodEnd ? [...sameDate("periodEnd", periodEnd)] : []),
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

/** Whether a mandate can still be charged (valid, or pending confirmation). */
async function mandateUsable(
	options: MollieOptions,
	customerId: string,
	mandateId: string,
): Promise<boolean> {
	try {
		const mandate = await gatewayFor(options).getMandate(customerId, mandateId);
		return mandate.status !== "invalid";
	} catch (error) {
		if (isMollieNotFound(error)) return false;
		throw error;
	}
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
