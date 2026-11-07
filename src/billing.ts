import type { GenericEndpointContext, Where } from "better-auth";
import type { BillingEvent } from "./events";
import { gatewayFor, type MolliePayment, type MollieSubscription, metadataOf } from "./gateway";
import { OperationInProgressError, runOperation, withLock } from "./operations";
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

async function reload(ctx: Ctx, id: string): Promise<Subscription | null> {
	return findSubscription(ctx, [{ field: "id", value: id }]);
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

/** Whether a reference is a user or an organization (for the tax hook). */
export async function customerTypeOf(ctx: Ctx, referenceId: string): Promise<CustomerType> {
	const user = await ctx.context.adapter.findOne({
		model: "user",
		where: [{ field: "id", value: referenceId }],
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

/**
 * Applies a payment fetched from Mollie to local state. Safe to call any
 * number of times for the same payment: state changes are driven by the
 * payment's status (so a crash between steps is repaired by the next call),
 * and hook events are emitted once per transition.
 *
 * A payment that turns out to pay for something already paid (two checkouts
 * paid, a recovery racing Mollie's own retry, a charge by a replaced Mollie
 * subscription) is refunded, by the one caller that saw it become paid.
 */
export async function processPayment(
	ctx: Ctx,
	options: MollieOptions,
	payment: MolliePayment,
): Promise<ProcessResult> {
	let subscription = await resolveSubscription(ctx, payment);
	if (!subscription) return { subscription: null, events: [], ignored: "unknown payment" };

	const { record, transitioned } = await recordPayment(ctx, payment, subscription.id);
	const purpose = paymentPurpose(payment);
	const status = payment.status as string;
	const events: BillingEvent[] = [];
	let duplicate = false;
	let applied: Subscription | null = null;

	if (status === "paid") {
		if (purpose === "checkout" || purpose === "verification" || purpose === "recovery") {
			applied =
				purpose === "recovery"
					? await recoverSubscription(ctx, options, subscription, payment)
					: await activateSubscription(ctx, options, subscription, payment);
			if (applied) {
				subscription = applied;
				const plan = await getPlanByName(options, applied.plan);
				events.push({ type: "subscription.activated", subscription: applied, plan, payment });
			} else if (transitioned && subscription.status !== "incomplete") {
				// Another payment already activated or recovered this subscription.
				duplicate = (await reload(ctx, subscription.id))?.status !== "incomplete";
			}
		} else if (purpose === "renewal") {
			const renewed = await applyRenewal(ctx, options, subscription, payment);
			if (renewed) {
				subscription = renewed;
			} else if (
				transitioned &&
				payment.subscriptionId &&
				payment.subscriptionId !== subscription.mollieSubscriptionId
			) {
				// Charged by a Mollie subscription that was replaced, for a period
				// that is already paid.
				duplicate = true;
			}
		}
		// A paid proration changes nothing: the upgrade was applied when charged.
	} else if (isFinalPaymentStatus(status)) {
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

	if (transitioned && (status === "paid" || isFailedPaymentStatus(status))) {
		const latest = (await reload(ctx, subscription.id)) ?? subscription;
		const data = await paymentHookData(options, payment, record, latest);
		events.push({ type: status === "paid" ? "payment.paid" : "payment.failed", data });
		if (duplicate) events.push(...(await refundDuplicate(ctx, options, data)));
	}
	// A new mandate or a new start needs Mollie brought in line right away.
	if (applied || needsRemote(subscription)) {
		await ensureRemoteQuietly(ctx, options, subscription.id);
	}
	return { subscription, events };
}

/**
 * First payment paid: move `incomplete → trialing | active` with the new
 * mandate and the plan that was paid for. The Mollie subscription is created
 * afterwards by `ensureRemote`. Only one payment can win the guarded update.
 */
async function activateSubscription(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
): Promise<Subscription | null> {
	if (subscription.status !== "incomplete") return null;
	const metadata = metadataOf(payment);
	const plan = await getPlanByName(
		options,
		typeof metadata.plan === "string" ? metadata.plan : subscription.plan,
	);
	const customerId = payment.customerId ?? subscription.mollieCustomerId;
	if (!plan || !payment.mandateId || !customerId) {
		ctx.context.logger.error(
			`[mollie] Cannot activate ${subscription.id} from payment ${payment.id}: plan or mandate missing`,
		);
		return null;
	}
	const anchor = toDate(payment.paidAt) ?? new Date(payment.createdAt);
	const trialDays = typeof metadata.trialDays === "number" ? metadata.trialDays : 0;
	const isTrial = metadata.trial === true && trialDays > 0;
	const trialEnd = isTrial ? ceilToUTCDate(addDays(anchor, trialDays)) : null;
	const periodEnd = trialEnd ?? ceilToUTCDate(addInterval(anchor, plan.interval));
	return guardedUpdate(ctx, subscription.id, ["incomplete"], {
		status: isTrial ? "trialing" : "active",
		plan: plan.name.toLowerCase(),
		pendingPlan: null,
		mollieCustomerId: customerId,
		mollieMandateId: payment.mandateId,
		periodStart: anchor,
		periodEnd,
		trialEnd,
		cancelAtPeriodEnd: false,
	});
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
	subscription: Subscription,
	payment: MolliePayment,
): Promise<Subscription | null> {
	if (subscription.status !== "past_due" && subscription.status !== "unpaid") return null;
	const metadata = metadataOf(payment);
	const plan = await getPlanByName(
		options,
		typeof metadata.plan === "string" ? metadata.plan : subscription.plan,
	);
	const customerId = payment.customerId ?? subscription.mollieCustomerId;
	if (!plan || !payment.mandateId || !customerId) {
		ctx.context.logger.error(
			`[mollie] Cannot recover ${subscription.id} from payment ${payment.id}`,
		);
		return null;
	}
	const anchor = toDate(payment.paidAt) ?? new Date(payment.createdAt);
	return guardedUpdate(
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
		},
		subscription.periodStart ? [{ field: "periodStart", operator: "lt", value: anchor }] : [],
	);
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
 * move `trialing`/`past_due`/`unpaid` to `active`.
 *
 * A payment only pays for its own period. The newest payment of the Mollie
 * subscription pays up to Mollie's `nextPaymentDate`, so a late retry does
 * not shift the schedule; an older payment (re-delivered, or re-read by the
 * cron) pays one interval from its own charge date, which never reaches past
 * a period that is already paid. Nothing changes unless the period advances.
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
	let isNewest = false;
	const customerId = payment.customerId ?? initial.mollieCustomerId;
	if (payment.subscriptionId && customerId) {
		const gateway = gatewayFor(options);
		try {
			const [mollieSubscription, recent] = await Promise.all([
				gateway.getSubscription(customerId, payment.subscriptionId),
				gateway.listSubscriptionPayments(customerId, payment.subscriptionId, 5),
			]);
			interval = mollieSubscription.interval ?? interval;
			if (mollieSubscription.nextPaymentDate) {
				nextPaymentDate = fromMollieDate(mollieSubscription.nextPaymentDate);
			}
			isNewest = recent[0]?.id === payment.id;
		} catch (error) {
			ctx.context.logger.warn(
				`[mollie] Could not load subscription ${payment.subscriptionId}: ${errorMessage(error)}`,
			);
		}
	}
	const chargedOn = startOfUTCDay(createdAt);
	const paidUntil =
		isNewest && nextPaymentDate && nextPaymentDate > createdAt
			? nextPaymentDate
			: interval
				? ceilToUTCDate(addInterval(chargedOn, interval))
				: null;
	if (!paidUntil) return null;

	let subscription = initial;
	for (let attempt = 0; attempt < 3; attempt++) {
		const currentEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
		if (currentEnd && paidUntil <= currentEnd) return null;
		const periodStart = currentEnd && currentEnd <= createdAt ? currentEnd : chargedOn;
		// The first charge of a scheduled plan change, by the Mollie
		// subscription that bills it: that plan is now active.
		const fromCurrentRemote =
			!!payment.subscriptionId && payment.subscriptionId === subscription.mollieSubscriptionId;
		const switchPlan =
			fromCurrentRemote && !!subscription.pendingPlan && billedPlan === subscription.pendingPlan;
		const guards: Where[] = currentEnd ? [{ field: "periodEnd", value: currentEnd }] : [];
		if (switchPlan) {
			guards.push(
				{ field: "pendingPlan", value: subscription.pendingPlan as string },
				{ field: "mollieSubscriptionId", value: subscription.mollieSubscriptionId as string },
			);
		}
		const updated = await guardedUpdate(
			ctx,
			subscription.id,
			["trialing", "active", "past_due", "unpaid"],
			{
				status: "active",
				periodStart,
				periodEnd: paidUntil,
				...(switchPlan ? { plan: subscription.pendingPlan as string, pendingPlan: null } : {}),
			},
			guards,
		);
		if (updated) return updated;
		const reread = await reload(ctx, subscription.id);
		if (!reread || !BILLING_STATUSES.includes(reread.status)) return null;
		subscription = reread;
	}
	return null;
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

/**
 * A payment paid for something already paid: refund it (unless
 * `subscription.refundDuplicatePayments` is false) and tell the app.
 */
async function refundDuplicate(
	ctx: Ctx,
	options: MollieOptions,
	data: PaymentHookData,
): Promise<BillingEvent[]> {
	const { payment, subscription } = data;
	const enabled =
		options.subscription?.enabled && options.subscription.refundDuplicatePayments !== false;
	ctx.context.logger.warn(
		`[mollie] Payment ${payment.id} pays for something already paid on ${subscription.id}${enabled ? "; refunding" : ""}`,
	);
	if (enabled) await refundPayment(ctx, options, subscription, payment);
	return [{ type: "payment.duplicate", data, refunded: !!enabled }];
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

/** Whether Mollie is still processing a charge of the current Mollie subscription. */
export async function hasPaymentInProgress(
	options: MollieOptions,
	subscription: Subscription,
): Promise<boolean> {
	const customerId = subscription.mollieCustomerId;
	if (!customerId || !subscription.mollieSubscriptionId) return false;
	const recent = await gatewayFor(options).listSubscriptionPayments(
		customerId,
		subscription.mollieSubscriptionId,
		3,
	);
	return recent.some((p) => !isFinalPaymentStatus(p.status as string));
}

/**
 * Makes Mollie match the subscription row (the source of truth):
 *
 * - `trialing`/`active`/`past_due` and not canceling: exactly one running
 *   Mollie subscription for `pendingPlan ?? plan`, on the row's mandate, for
 *   the current amount (VAT included), charging from `periodEnd`;
 * - canceling or ended: no running Mollie subscription.
 *
 * A mismatch (plan change, new mandate, changed VAT, restore, an interrupted
 * earlier attempt) is fixed by canceling the old Mollie subscription and
 * creating the right one, both through the journal. Idempotent; the caller
 * must hold the subscription's lock (see `ensureRemote`).
 */
export async function reconcileRemote(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	now: Date = new Date(),
): Promise<Subscription> {
	const customerId = subscription.mollieCustomerId;
	if (!customerId || subscription.status === "incomplete") return subscription;
	// An unpaid subscription keeps its Mollie subscription (a later charge may
	// still succeed) unless it is being canceled.
	if (subscription.status === "unpaid" && !subscription.cancelAtPeriodEnd) return subscription;
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
		if (isLive(actual)) await cancelMollieSubscription(ctx, options, subscription);
		return subscription;
	}

	const plan = await getPlanByName(options, subscription.pendingPlan ?? subscription.plan);
	if (!plan) {
		ctx.context.logger.error(`[mollie] Plan of ${subscription.id} is not configured`);
		return subscription;
	}
	const tax = await resolveTax(ctx, options, {
		referenceId: subscription.referenceId,
		customerType: await customerTypeOf(ctx, subscription.referenceId),
		plan,
	});
	const amount = chargeAmount(plan, tax);
	if (
		actual &&
		isLive(actual) &&
		metadataOf(actual).plan === plan.name.toLowerCase() &&
		actual.mandateId === subscription.mollieMandateId &&
		actual.amount.value === amount &&
		actual.amount.currency === planCurrency(plan) &&
		actual.interval === plan.interval
	) {
		return subscription;
	}

	if (isLive(actual)) await cancelMollieSubscription(ctx, options, subscription);
	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
	const startAt = periodEnd && periodEnd > now ? periodEnd : ceilToUTCDate(now);
	const previous = subscription.mollieSubscriptionId ?? null;
	const mollieSubscriptionId = await createScheduledSubscription(ctx, options, {
		subscription,
		plan,
		mandateId: subscription.mollieMandateId as string,
		startAt,
		tax,
		scope: `remote:${subscription.id}:${plan.name.toLowerCase()}:${toMollieDate(startAt)}:${subscription.mollieMandateId}:${amount}:${previous ?? "none"}`,
	});
	const adopted = await guardedUpdate(
		ctx,
		subscription.id,
		ACCESS_STATUSES,
		{ mollieSubscriptionId },
		previous ? [{ field: "mollieSubscriptionId", value: previous }] : [],
	);
	if (adopted) return adopted;
	const latest = await reload(ctx, subscription.id);
	if (latest?.mollieSubscriptionId === mollieSubscriptionId) return latest;
	// The row moved on meanwhile: this Mollie subscription must not charge.
	await cancelMollieSubscription(ctx, options, { ...subscription, mollieSubscriptionId });
	return latest ?? subscription;
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
		async () => {
			const fresh = await reload(ctx, subscriptionId);
			return fresh ? reconcileRemote(ctx, options, fresh, now) : null;
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
	for (const remote of await gatewayFor(options).listCustomerSubscriptions(customerId)) {
		if (remote.id === subscription.mollieSubscriptionId) continue;
		if (!isLive(remote)) continue;
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

/**
 * Brings one subscription up to date with Mollie and the clock:
 *
 * - open checkouts (first payments, including recovery checkouts) and paid
 *   recoveries that were not applied yet are (re)processed;
 * - unresolved recurring payments (e.g. a pro-rata charge whose webhook was
 *   missed) are fetched and processed;
 * - clock-based transitions are applied;
 * - from one day before `periodEnd` (Mollie's next payment date), and always
 *   for delinquent subscriptions, Mollie is checked: subscription status,
 *   recent payments, orphans, and `ensureRemote` (plan, mandate, VAT).
 *   Stable subscriptions are not fetched outside that window.
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

	const records = await ctx.context.adapter.findMany<MolliePaymentRecord>({
		model: "molliePayment",
		where: [{ field: "subscriptionId", value: initial.id }],
		sortBy: { field: "molliePaymentId", direction: "asc" },
		limit: 500,
	});
	const delinquent = initial.status === "past_due" || initial.status === "unpaid";
	const periodStart = initial.periodStart ? new Date(initial.periodStart).getTime() : 0;
	for (const record of records) {
		const unresolved = !isFinalPaymentStatus(record.status);
		const first = record.sequenceType === "first";
		const paidCheckout = first && record.status === "paid" && initial.status === "incomplete";
		const paidRecovery =
			first &&
			record.status === "paid" &&
			delinquent &&
			!!record.paidAt &&
			new Date(record.paidAt).getTime() > periodStart;
		if (!unresolved && !paidCheckout && !paidRecovery) continue;
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
		const attempts = records.filter((r) => r.sequenceType === "first");
		const ended =
			attempts.length > 0 &&
			attempts.every((a) => isFinalPaymentStatus(a.status) && a.status !== "paid");
		if (ended) await expireCheckout(ctx, subscription);
		return { events, checkedRemote };
	}
	if (!BILLING_STATUSES.includes(subscription.status)) return { events, checkedRemote };

	const timed = await applyTimeTransitions(ctx, options, subscription, now);
	events.push(...timed.events);
	subscription = timed.subscription;
	if (!BILLING_STATUSES.includes(subscription.status)) return { events, checkedRemote };
	const customerId = subscription.mollieCustomerId;
	if (!customerId) return { events, checkedRemote };

	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
	const stable = subscription.status === "active" || subscription.status === "trialing";
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
