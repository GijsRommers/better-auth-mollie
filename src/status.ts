import type { MolliePaymentStatus, Subscription, SubscriptionStatus } from "./types";
import { addDays } from "./utils";

export const DEFAULT_GRACE_PERIOD_DAYS = 14;
export const DEFAULT_VERIFICATION_AMOUNT = "0.02";

/** Statuses in which access may still be granted (subject to dates). */
export const ACCESS_STATUSES: readonly SubscriptionStatus[] = ["trialing", "active", "past_due"];

/** Statuses in which a Mollie subscription may still charge the customer. */
export const BILLING_STATUSES: readonly SubscriptionStatus[] = [
	"trialing",
	"active",
	"past_due",
	"unpaid",
];

/** Statuses that `syncMollieSubscriptions` keeps an eye on. */
export const SYNCABLE_STATUSES: readonly SubscriptionStatus[] = ["incomplete", ...BILLING_STATUSES];

/**
 * The moment access ends if nothing changes:
 * - pending cancellation: `periodEnd`
 * - otherwise: `periodEnd + gracePeriodDays` (a renewal can be late or fail
 *   and still be recovered, e.g. slow SEPA Direct Debit)
 */
export function accessDeadline(
	subscription: Pick<Subscription, "periodEnd" | "cancelAtPeriodEnd">,
	gracePeriodDays: number,
): Date | null {
	if (!subscription.periodEnd) return null;
	const periodEnd = new Date(subscription.periodEnd);
	return subscription.cancelAtPeriodEnd ? periodEnd : addDays(periodEnd, gracePeriodDays);
}

/**
 * Whether a subscription currently grants access. Pure: does not write.
 */
export function hasSubscriptionAccess(
	subscription: Pick<Subscription, "status" | "periodEnd" | "cancelAtPeriodEnd">,
	options: { now?: Date | undefined; gracePeriodDays?: number | undefined } = {},
): boolean {
	if (!ACCESS_STATUSES.includes(subscription.status)) return false;
	const deadline = accessDeadline(
		subscription,
		options.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS,
	);
	if (!deadline) return subscription.status !== "past_due";
	return (options.now ?? new Date()).getTime() < deadline.getTime();
}

/**
 * Maps a Mollie subscription status to the local status it implies, or
 * `null` when it implies no change.
 */
export function mapMollieSubscriptionStatus(
	status: string,
): Extract<SubscriptionStatus, "past_due" | "canceled"> | null {
	switch (status) {
		case "suspended":
			return "past_due";
		case "canceled":
		case "completed":
			return "canceled";
		default:
			return null;
	}
}

const PAYMENT_STATUS_RANK: Record<MolliePaymentStatus, number> = {
	open: 0,
	pending: 1,
	authorized: 2,
	paid: 3,
	failed: 3,
	canceled: 3,
	expired: 3,
};

export function isFinalPaymentStatus(status: string): boolean {
	return (PAYMENT_STATUS_RANK[status as MolliePaymentStatus] ?? 0) >= 3;
}

/**
 * Payment status only moves forward: `open → pending → authorized → final`.
 * Final statuses never change.
 */
export function canAdvancePayment(from: string, to: string): boolean {
	const fromRank = PAYMENT_STATUS_RANK[from as MolliePaymentStatus];
	const toRank = PAYMENT_STATUS_RANK[to as MolliePaymentStatus];
	if (fromRank === undefined || toRank === undefined) return false;
	return toRank > fromRank;
}

/** Payment statuses that count as a failed collection attempt. */
export function isFailedPaymentStatus(status: string): boolean {
	return status === "failed" || status === "expired";
}
