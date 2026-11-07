import type { GenericEndpointContext as Ctx, Where } from "better-auth";
import type { BillingEvent } from "./events";
import { gatewayFor, type MolliePayment, type MollieSubscription } from "./gateway";
import { type SubscriptionLock, withSubscriptionLock } from "./lock";
import { runOperation } from "./operations";
import {
	findSubscription,
	guardedUpdate,
	lockWaitMs,
	periodEndOf,
	reload,
	sameDate,
	subscriptionDescription,
} from "./rows";
import { mapMollieSubscriptionStatus } from "./status";
import { chargeAmount, fromCents, taxMetadata, toCents } from "./tax";
import type { MollieOptions, MolliePlan, Subscription, TaxBreakdown } from "./types";
import {
	getPlanByName,
	getWebhookUrl,
	isMollieApiError,
	isMollieNotFound,
	planCurrency,
	toMollieDate,
} from "./utils";

/**
 * The Mollie side of a subscription: creating, canceling and refunding
 * through the operation journal, and applying the status Mollie reports for
 * a Mollie subscription to the row.
 */

/** The Mollie subscription, or `null` when Mollie no longer has it. */
export async function findRemote(
	options: MollieOptions,
	customerId: string,
	mollieSubscriptionId: string,
): Promise<MollieSubscription | null> {
	try {
		return await gatewayFor(options).getSubscription(customerId, mollieSubscriptionId);
	} catch (error) {
		if (isMollieNotFound(error)) return null;
		throw error;
	}
}

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

export function isLive(subscription: { status?: string | null } | null): boolean {
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
		const remote = await findRemote(options, customerId, mollieSubscriptionId);
		return !remote || isEnded(remote);
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
 * Refunds a payment in full, through the journal (at most once per payment).
 */
export async function refundPayment(
	ctx: Ctx,
	options: MollieOptions,
	subscription: Subscription,
	payment: MolliePayment,
	description = "Refund of a subscription payment that could not be applied",
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
					// What is left of it (part may be refunded by hand already).
					amount: { currency: payment.amount.currency, value: refundableAmount(payment) },
					description,
					metadata: { subscriptionId: subscription.id, operationKey: idempotencyKey },
				},
				idempotencyKey,
			),
		getId: (refund) => refund.id,
		recover: (idempotencyKey) => gateway.findRefundByOperationKey(payment.id, idempotencyKey),
	});
}

/** What Mollie can still refund of a payment, at most its amount. */
export function refundableAmount(payment: MolliePayment): string {
	const remaining = payment.amountRemaining;
	if (!remaining) return payment.amount.value;
	return fromCents(Math.min(toCents(remaining.value), toCents(payment.amount.value)));
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
	lock: SubscriptionLock,
): Promise<BillingEvent[]> {
	if (mollieSubscription.id !== subscription.mollieSubscriptionId) return [];
	const implied = mapMollieSubscriptionStatus(mollieSubscription.status);
	const sameRemote: Where[] = [{ field: "mollieSubscriptionId", value: mollieSubscription.id }];
	if (implied === "past_due") {
		// Suspended at Mollie: it will not charge again. That only makes the
		// subscription delinquent once what was paid for has run out (until then
		// the overdue fallback of the sync would catch a missing renewal).
		const paidThrough = periodEndOf(subscription);
		if (paidThrough && paidThrough > new Date()) return [];
		await guardedUpdate(
			ctx,
			subscription.id,
			["trialing", "active"],
			{ status: "past_due" },
			[
				...sameRemote,
				{ field: "cancelAtPeriodEnd", value: false },
				...(subscription.periodEnd
					? [...sameDate("periodEnd", new Date(subscription.periodEnd))]
					: []),
			],
			{ lock },
		);
		return [];
	}
	if (implied !== "canceled" || subscription.cancelAtPeriodEnd) return [];
	// Canceled by this plugin (e.g. the first step of replacing it), not by
	// Mollie or the merchant: `reconcileRemote` finishes that replacement.
	if (await canceledByUs(ctx, subscription, mollieSubscription.id)) return [];
	if (subscription.status === "past_due" || subscription.status === "unpaid") {
		const canceled = await guardedUpdate(
			ctx,
			subscription.id,
			["past_due", "unpaid"],
			{ status: "canceled", pendingPlan: null },
			sameRemote,
			{ mollieSync: true, lock },
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
			{ lock },
		);
	}
	return [];
}

/**
 * A webhook for a Mollie subscription (e.g. Mollie suspended or canceled it):
 * its status is read from Mollie, then applied under the subscription's lock
 * to the row as it is now.
 */
export async function processMollieSubscription(
	ctx: Ctx,
	options: MollieOptions,
	mollieSubscriptionId: string,
): Promise<BillingEvent[]> {
	const initial = await findSubscription(ctx, [
		{ field: "mollieSubscriptionId", value: mollieSubscriptionId },
	]);
	if (!initial?.mollieCustomerId) return [];
	return withSubscriptionLock(
		ctx,
		initial.id,
		async (lock) => {
			// Mollie's status is read under the lock, so it is never older than
			// the row it is applied to.
			const fresh = await reload(ctx, initial.id);
			const customerId = fresh?.mollieCustomerId;
			if (!fresh || !customerId) return [];
			const mollieSubscription = await gatewayFor(options)
				.getSubscription(customerId, mollieSubscriptionId)
				.catch((error: unknown) => {
					if (isMollieNotFound(error)) return null;
					throw error;
				});
			return mollieSubscription
				? reconcileMollieSubscription(ctx, options, fresh, mollieSubscription, lock)
				: [];
		},
		{ waitMs: lockWaitMs(options) },
	);
}
