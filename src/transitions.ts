import type { GenericEndpointContext as Ctx } from "better-auth";
import type { BillingEvent } from "./events";
import { type SubscriptionLock, withSubscriptionLock } from "./lock";
import { OperationInProgressError } from "./operations";
import { gracePeriodDays, guardedUpdate, periodEndOf, reload, sameDate } from "./rows";
import { BILLING_STATUSES } from "./status";
import type { MollieOptions, Subscription } from "./types";
import { addDays, planForHooks } from "./utils";

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
			[{ field: "cancelAtPeriodEnd", value: true }, ...sameDate("periodEnd", periodEnd)],
			{ mollieSync: true, lock },
		);
		if (!canceled) return { subscription, events: [] };
		const plan = await planForHooks(options, canceled.plan);
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
				...sameDate("periodEnd", periodEnd),
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
			[...sameDate("periodEnd", periodEnd)],
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
