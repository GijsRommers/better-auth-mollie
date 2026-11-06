import type { GenericEndpointContext, Where } from "better-auth";
import type { BillingEvent } from "./events";
import { gatewayFor, type MolliePayment, type MollieSubscription, metadataOf } from "./gateway";
import { runOperation } from "./operations";
import {
	BILLING_STATUSES,
	canAdvancePayment,
	DEFAULT_GRACE_PERIOD_DAYS,
	isFailedPaymentStatus,
	isFinalPaymentStatus,
	mapMollieSubscriptionStatus,
	SYNCABLE_STATUSES,
} from "./status";
import { chargeAmount, taxFromMetadata, taxMetadata } from "./tax";
import type {
	MollieOptions,
	MolliePaymentRecord,
	MolliePlan,
	PaymentHookData,
	PaymentPurpose,
	Subscription,
	SubscriptionStatus,
	TaxBreakdown,
} from "./types";
import {
	addDays,
	addInterval,
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

function startOfUTCDay(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export async function findSubscription(ctx: Ctx, where: Where[]): Promise<Subscription | null> {
	return ctx.context.adapter.findOne<Subscription>({ model: "subscription", where });
}

/**
 * Atomic, guarded update: only applies while the row's status is one of
 * `from` (and any extra conditions hold). Returns the updated row or `null`.
 */
export async function guardedUpdate(
	ctx: Ctx,
	id: string,
	from: readonly SubscriptionStatus[],
	set: Partial<Subscription>,
	extra: Where[] = [],
): Promise<Subscription | null> {
	return ctx.context.adapter.incrementOne<Subscription>({
		model: "subscription",
		where: [
			{ field: "id", value: id },
			{ field: "status", operator: "in", value: [...from] },
			...extra,
		],
		increment: {},
		set: { ...set, updatedAt: new Date() },
	});
}

/** Mollie wants descriptions unique per customer; the subscription id makes them so. */
export function subscriptionDescription(plan: MolliePlan, subscription: Subscription): string {
	return `${plan.description ?? `${plan.name} subscription`} · ${subscription.id}`;
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

/**
 * Applies a payment fetched from Mollie to local state. Safe to call any
 * number of times for the same payment: state changes are driven by the
 * payment's status (so a crash between steps is repaired by the next call),
 * and hook events are emitted once per transition.
 */
export async function processPayment(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
): Promise<ProcessResult> {
	let subscription = await resolveSubscription(ctx, payment);
	if (!subscription) return { subscription: null, events: [], ignored: "unknown payment" };

	const metadata = metadataOf(payment);
	const purpose = paymentPurpose(payment);
	const paidPlanName = typeof metadata.plan === "string" ? metadata.plan : subscription.plan;
	const plan = await getPlanByName(options, paidPlanName);
	const { record, transitioned } = await recordPayment(ctx, payment, subscription.id);
	const status = payment.status as string;
	const events: BillingEvent[] = [];
	const isCheckout = purpose === "checkout" || purpose === "verification";

	if (status === "paid") {
		if (isCheckout || purpose === "recovery") {
			const activated =
				purpose === "recovery"
					? await recoverSubscription(ctx, options, subscription, payment, plan)
					: await activateSubscription(ctx, options, subscription, payment, plan);
			if (activated) {
				subscription = activated;
				events.push({ type: "subscription.activated", subscription: activated, plan, payment });
			}
		} else if (purpose === "renewal") {
			subscription = (await applyRenewal(ctx, options, subscription, payment)) ?? subscription;
		}
		// A paid proration changes nothing: the upgrade was applied when charged.
	} else if (isFinalPaymentStatus(status)) {
		if (isCheckout && transitioned) {
			subscription = (await expireCheckout(ctx, subscription)) ?? subscription;
		} else if (
			(purpose === "renewal" || purpose === "proration") &&
			isFailedPaymentStatus(status)
		) {
			subscription = (await applyFailedRenewal(ctx, subscription, payment)) ?? subscription;
		}
		// A failed recovery leaves the subscription as it was.
	}

	if (transitioned && (status === "paid" || isFailedPaymentStatus(status))) {
		const latest =
			(await findSubscription(ctx, [{ field: "id", value: subscription.id }])) ?? subscription;
		const data: PaymentHookData = {
			payment,
			purpose,
			record,
			subscription: latest,
			plan,
			isVerification: purpose === "verification",
			tax: purpose === "verification" ? null : taxFromMetadata(metadata, payment.amount.currency),
		};
		events.push({ type: status === "paid" ? "payment.paid" : "payment.failed", data });
	}
	return { subscription, events };
}

/**
 * First payment paid: create the Mollie subscription with the new mandate and
 * move `incomplete → trialing | active`. The customer gets the plan they paid
 * for, even if they started another checkout afterwards. Idempotent: the
 * Mollie call is journaled per payment, and the status change is guarded.
 */
async function activateSubscription(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
	plan: MolliePlan | undefined,
): Promise<Subscription | null> {
	if (subscription.status !== "incomplete") return null;
	const metadata = metadataOf(payment);
	const logger = ctx.context.logger;
	if (!plan) {
		logger.error(`[mollie] Cannot activate ${subscription.id}: the paid plan is not configured`);
		return null;
	}
	const customerId = payment.customerId ?? subscription.mollieCustomerId;
	if (!payment.mandateId || !customerId) {
		logger.error(`[mollie] Paid first payment ${payment.id} has no mandate; cannot activate`);
		return null;
	}

	const anchor = toDate(payment.paidAt) ?? new Date(payment.createdAt);
	const trialDays = typeof metadata.trialDays === "number" ? metadata.trialDays : 0;
	const isTrial = metadata.trial === true && trialDays > 0;
	const trialEnd = isTrial ? ceilToUTCDate(addDays(anchor, trialDays)) : null;
	const periodEnd = trialEnd ?? ceilToUTCDate(addInterval(anchor, plan.interval));
	const tax = taxFromMetadata(metadata, planCurrency(plan));

	const mollieSubscriptionId = await createScheduledSubscription(ctx, options, {
		subscription: { ...subscription, mollieCustomerId: customerId },
		plan,
		mandateId: payment.mandateId,
		startAt: periodEnd,
		tax,
		scope: `subscription:${subscription.id}:activate:${payment.id}`,
	});

	return guardedUpdate(ctx, subscription.id, ["incomplete"], {
		status: isTrial ? "trialing" : "active",
		plan: plan.name.toLowerCase(),
		pendingPlan: null,
		mollieCustomerId: customerId,
		mollieMandateId: payment.mandateId,
		mollieSubscriptionId,
		periodStart: anchor,
		periodEnd,
		trialEnd,
		cancelAtPeriodEnd: false,
	});
}

/**
 * Recovery payment paid (a new first payment for a `past_due` or `unpaid`
 * subscription): a fresh period starts now, and the Mollie subscription is
 * replaced by one on the new mandate, starting at the end of that period.
 */
async function recoverSubscription(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
	plan: MolliePlan | undefined,
): Promise<Subscription | null> {
	if (subscription.status !== "past_due" && subscription.status !== "unpaid") return null;
	const customerId = payment.customerId ?? subscription.mollieCustomerId;
	if (!plan || !payment.mandateId || !customerId) {
		ctx.context.logger.error(
			`[mollie] Cannot recover ${subscription.id} from payment ${payment.id}`,
		);
		return null;
	}
	const anchor = toDate(payment.paidAt) ?? new Date(payment.createdAt);
	const periodEnd = ceilToUTCDate(addInterval(anchor, plan.interval));
	if (subscription.mollieSubscriptionId && !subscription.cancelAtPeriodEnd) {
		await cancelMollieSubscription(ctx, options, subscription);
	}
	const mollieSubscriptionId = await createScheduledSubscription(ctx, options, {
		subscription: { ...subscription, mollieCustomerId: customerId },
		plan,
		mandateId: payment.mandateId,
		startAt: periodEnd,
		tax: taxFromMetadata(metadataOf(payment), planCurrency(plan)),
		scope: `subscription:${subscription.id}:recover:${payment.id}`,
	});
	return guardedUpdate(ctx, subscription.id, ["past_due", "unpaid"], {
		status: "active",
		plan: plan.name.toLowerCase(),
		pendingPlan: null,
		mollieCustomerId: customerId,
		mollieMandateId: payment.mandateId,
		mollieSubscriptionId,
		periodStart: anchor,
		periodEnd,
		cancelAtPeriodEnd: false,
	});
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
	if (attempts.some((a) => !isFinalPaymentStatus(a.status) || a.status === "paid")) return null;
	return guardedUpdate(ctx, subscription.id, ["incomplete"], { status: "incomplete_expired" });
}

/**
 * A recurring payment was paid: advance the period (never backwards) and
 * recover `trialing`/`past_due`/`unpaid` to `active`. The new period ends at
 * Mollie's `nextPaymentDate`, so a late (retried) payment does not shift the
 * billing schedule.
 */
async function applyRenewal(
	ctx: Ctx,
	options: MollieOptions,
	initial: Subscription,
	payment: MolliePayment,
): Promise<Subscription | null> {
	const createdAt = new Date(payment.createdAt);
	const billedPlan = metadataOf(payment).plan;
	const plan = await getPlanByName(
		options,
		typeof billedPlan === "string" ? billedPlan : initial.plan,
	);
	let interval = plan?.interval as string | undefined;
	let nextPaymentDate: Date | null = null;
	const customerId = payment.customerId ?? initial.mollieCustomerId;
	if (payment.subscriptionId && customerId) {
		try {
			const mollieSubscription = await gatewayFor(options).getSubscription(
				customerId,
				payment.subscriptionId,
			);
			interval = mollieSubscription.interval ?? interval;
			if (mollieSubscription.nextPaymentDate) {
				nextPaymentDate = fromMollieDate(mollieSubscription.nextPaymentDate);
			}
		} catch (error) {
			ctx.context.logger.warn(
				`[mollie] Could not load subscription ${payment.subscriptionId}: ${errorMessage(error)}`,
			);
		}
	}

	let subscription = initial;
	for (let attempt = 0; attempt < 3; attempt++) {
		const currentEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
		const periodStart =
			currentEnd && currentEnd <= createdAt ? currentEnd : startOfUTCDay(createdAt);
		const periodEnd =
			nextPaymentDate && nextPaymentDate > createdAt
				? nextPaymentDate
				: interval
					? ceilToUTCDate(addInterval(periodStart, interval))
					: null;
		const advance = !!periodEnd && (!currentEnd || periodEnd > currentEnd);
		const current = !subscription.periodStart || createdAt >= new Date(subscription.periodStart);
		const recover = subscription.status !== "active" && current;
		// The first charge of a scheduled plan change: that plan is now active.
		const switchPlan =
			advance && !!subscription.pendingPlan && billedPlan === subscription.pendingPlan;
		if (!advance && !recover) return null;

		const updated = await guardedUpdate(
			ctx,
			subscription.id,
			["trialing", "active", "past_due", "unpaid"],
			{
				status: "active",
				...(advance ? { periodStart, periodEnd } : {}),
				...(switchPlan ? { plan: subscription.pendingPlan as string, pendingPlan: null } : {}),
			},
			currentEnd ? [{ field: "periodEnd", value: currentEnd }] : [],
		);
		if (updated) return updated;
		const reread = await findSubscription(ctx, [{ field: "id", value: subscription.id }]);
		if (!reread || !BILLING_STATUSES.includes(reread.status)) return null;
		subscription = reread;
	}
	return null;
}

/**
 * A recurring payment failed: `trialing | active → past_due`, unless the
 * payment predates the current period (a later payment already succeeded).
 */
async function applyFailedRenewal(
	ctx: Ctx,
	subscription: Subscription,
	payment: MolliePayment,
): Promise<Subscription | null> {
	if (subscription.status !== "trialing" && subscription.status !== "active") return null;
	if (subscription.cancelAtPeriodEnd) return null;
	const createdAt = new Date(payment.createdAt);
	if (subscription.periodStart && createdAt < new Date(subscription.periodStart)) return null;
	return guardedUpdate(ctx, subscription.id, ["trialing", "active"], { status: "past_due" });
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
): Promise<string> {
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
	return operation.mollieId;
}

function isEnded(subscription: { status?: string | null }): boolean {
	return subscription.status === "canceled" || subscription.status === "completed";
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
	if (implied === "past_due") {
		await guardedUpdate(ctx, subscription.id, ["trialing", "active"], { status: "past_due" });
		return [];
	}
	if (implied !== "canceled" || subscription.cancelAtPeriodEnd) return [];
	if (subscription.status === "past_due" || subscription.status === "unpaid") {
		const canceled = await guardedUpdate(ctx, subscription.id, ["past_due", "unpaid"], {
			status: "canceled",
		});
		if (!canceled) return [];
		const plan = await getPlanByName(options, canceled.plan);
		return [
			{ type: "subscription.canceled", subscription: canceled, plan, reason: "mollie_canceled" },
		];
	}
	if (subscription.status === "trialing" || subscription.status === "active") {
		await guardedUpdate(ctx, subscription.id, ["trialing", "active"], { cancelAtPeriodEnd: true });
	}
	return [];
}

// ---------------------------------------------------------------------------
// Time-based transitions and sync
// ---------------------------------------------------------------------------

/**
 * Transitions that only depend on the clock:
 * - pending cancellation past `periodEnd` → `canceled`
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
		const canceled = await guardedUpdate(ctx, subscription.id, BILLING_STATUSES, {
			status: "canceled",
			pendingPlan: null,
		});
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
			[{ field: "pendingPlan", value: subscription.pendingPlan }],
		);
		if (switched) return applyTimeTransitions(ctx, options, switched, now);
	}
	if (subscription.status === "past_due" && now >= addDays(periodEnd, gracePeriodDays(options))) {
		const unpaid = await guardedUpdate(ctx, subscription.id, ["past_due"], { status: "unpaid" });
		return { subscription: unpaid ?? subscription, events: [] };
	}
	return { subscription, events: [] };
}

async function reload(ctx: Ctx, id: string): Promise<Subscription | null> {
	return findSubscription(ctx, [{ field: "id", value: id }]);
}

/**
 * Brings one subscription up to date with Mollie and the clock.
 *
 * Stable subscriptions (`trialing`/`active`, not due) are not fetched from
 * Mollie at all; they are re-checked from one day before `periodEnd` (the
 * Mollie `nextPaymentDate`) until a renewal is paid. Delinquent ones are
 * always re-checked.
 */
export async function syncSubscription(
	ctx: Ctx,
	options: MollieOptions,
	initial: Subscription,
	now: Date,
): Promise<{ events: BillingEvent[]; checkedRemote: boolean }> {
	const gateway = gatewayFor(options);
	const events: BillingEvent[] = [];

	// Checkouts (first payments, including recovery checkouts) still open.
	const attempts = await ctx.context.adapter.findMany<MolliePaymentRecord>({
		model: "molliePayment",
		where: [
			{ field: "subscriptionId", value: initial.id },
			{ field: "sequenceType", value: "first" },
		],
		limit: 100,
	});
	let checkedAttempts = false;
	for (const attempt of attempts) {
		const unresolved = !isFinalPaymentStatus(attempt.status);
		const paidButIncomplete = attempt.status === "paid" && initial.status === "incomplete";
		if (!unresolved && !paidButIncomplete) continue;
		checkedAttempts = true;
		const result = await processPayment(
			ctx,
			options,
			await gateway.getPayment(attempt.molliePaymentId),
		);
		events.push(...result.events);
	}
	if (initial.status === "incomplete") return { events, checkedRemote: checkedAttempts };

	const reloaded = checkedAttempts ? ((await reload(ctx, initial.id)) ?? initial) : initial;
	if (!BILLING_STATUSES.includes(reloaded.status))
		return { events, checkedRemote: checkedAttempts };
	const timed = await applyTimeTransitions(ctx, options, reloaded, now);
	events.push(...timed.events);
	let subscription = timed.subscription;
	if (!BILLING_STATUSES.includes(subscription.status) || subscription.cancelAtPeriodEnd) {
		return { events, checkedRemote: false };
	}
	const customerId = subscription.mollieCustomerId;
	const mollieSubscriptionId = subscription.mollieSubscriptionId;
	if (!customerId || !mollieSubscriptionId) return { events, checkedRemote: false };

	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
	const stable = subscription.status === "active" || subscription.status === "trialing";
	if (stable && periodEnd && now.getTime() < periodEnd.getTime() - DAY_MS) {
		return { events, checkedRemote: false };
	}

	const mollieSubscription = await gateway.getSubscription(customerId, mollieSubscriptionId);
	events.push(
		...(await reconcileMollieSubscription(ctx, options, subscription, mollieSubscription)),
	);
	for (const payment of await gateway.listSubscriptionPayments(customerId, mollieSubscriptionId)) {
		events.push(...(await processPayment(ctx, options, payment)).events);
	}

	subscription = (await reload(ctx, subscription.id)) ?? subscription;
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
	return { events, checkedRemote: true };
}

export type SyncResult = {
	checked: number;
	remoteChecked: number;
	errors: { subscriptionId: string; message: string }[];
};

/**
 * Runs `syncSubscription` over every subscription that may still change.
 */
export async function syncAllSubscriptions(
	ctx: Ctx,
	options: MollieOptions,
	input: { now?: Date | undefined; onEvents: (events: BillingEvent[]) => void },
): Promise<SyncResult> {
	const now = input.now ?? new Date();
	const ids: string[] = [];
	for (let offset = 0; ; offset += 100) {
		const page = await ctx.context.adapter.findMany<Pick<Subscription, "id">>({
			model: "subscription",
			where: [{ field: "status", operator: "in", value: [...SYNCABLE_STATUSES] }],
			select: ["id"],
			sortBy: { field: "id", direction: "asc" },
			limit: 100,
			offset,
		});
		ids.push(...page.map((row) => row.id));
		if (page.length < 100) break;
	}
	const result: SyncResult = { checked: 0, remoteChecked: 0, errors: [] };
	for (const id of ids) {
		const subscription = await reload(ctx, id);
		if (!subscription) continue;
		result.checked++;
		try {
			const { events, checkedRemote } = await syncSubscription(ctx, options, subscription, now);
			if (checkedRemote) result.remoteChecked++;
			input.onEvents(events);
		} catch (error) {
			result.errors.push({ subscriptionId: id, message: errorMessage(error) });
			ctx.context.logger.error(`[mollie] Sync of ${id} failed: ${errorMessage(error)}`);
		}
	}
	return result;
}
