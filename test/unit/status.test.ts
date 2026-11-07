import { describe, expect, it } from "vitest";
import {
	accessDeadline,
	canAdvancePayment,
	hasSubscriptionAccess,
	isFinalPaymentStatus,
	mapMollieSubscriptionStatus,
} from "../../src/status";

describe("hasSubscriptionAccess", () => {
	const periodEnd = new Date("2026-03-01T00:00:00Z");

	it("grants access to active and trialing subscriptions", () => {
		const now = new Date("2026-02-15T00:00:00Z");
		expect(hasSubscriptionAccess({ status: "active", periodEnd }, { now })).toBe(true);
		expect(hasSubscriptionAccess({ status: "trialing", periodEnd }, { now })).toBe(true);
	});

	it("keeps past_due access until periodEnd + gracePeriodDays", () => {
		const sub = { status: "past_due" as const, periodEnd };
		expect(hasSubscriptionAccess(sub, { now: new Date("2026-03-14T23:59:59Z") })).toBe(true);
		expect(hasSubscriptionAccess(sub, { now: new Date("2026-03-15T00:00:00Z") })).toBe(false);
		expect(
			hasSubscriptionAccess(sub, { now: new Date("2026-03-05T00:00:00Z"), gracePeriodDays: 3 }),
		).toBe(false);
	});

	it("ends access exactly at periodEnd for a pending cancellation", () => {
		const sub = { status: "active" as const, periodEnd, cancelAtPeriodEnd: true };
		expect(hasSubscriptionAccess(sub, { now: new Date("2026-02-28T23:59:59Z") })).toBe(true);
		expect(hasSubscriptionAccess(sub, { now: periodEnd })).toBe(false);
	});

	it("denies access for terminal and pre-activation statuses", () => {
		const now = new Date("2026-02-01T00:00:00Z");
		for (const status of ["incomplete", "incomplete_expired", "unpaid", "canceled"] as const) {
			expect(hasSubscriptionAccess({ status, periodEnd }, { now })).toBe(false);
		}
	});

	it("computes the access deadline", () => {
		expect(accessDeadline({ periodEnd }, 14)?.toISOString()).toBe("2026-03-15T00:00:00.000Z");
		expect(accessDeadline({ periodEnd, cancelAtPeriodEnd: true }, 14)).toEqual(periodEnd);
		expect(accessDeadline({ periodEnd: null }, 14)).toBeNull();
	});
});

describe("payment status", () => {
	it("only moves forward", () => {
		expect(canAdvancePayment("open", "pending")).toBe(true);
		expect(canAdvancePayment("open", "paid")).toBe(true);
		expect(canAdvancePayment("pending", "failed")).toBe(true);
		expect(canAdvancePayment("paid", "open")).toBe(false);
		expect(canAdvancePayment("paid", "failed")).toBe(false);
		expect(canAdvancePayment("failed", "paid")).toBe(false);
		expect(canAdvancePayment("open", "open")).toBe(false);
	});

	it("knows final statuses", () => {
		expect(isFinalPaymentStatus("paid")).toBe(true);
		expect(isFinalPaymentStatus("expired")).toBe(true);
		expect(isFinalPaymentStatus("open")).toBe(false);
		expect(isFinalPaymentStatus("authorized")).toBe(false);
	});
});

describe("mapMollieSubscriptionStatus", () => {
	it("maps suspended to past_due and canceled/completed to canceled", () => {
		expect(mapMollieSubscriptionStatus("suspended")).toBe("past_due");
		expect(mapMollieSubscriptionStatus("canceled")).toBe("canceled");
		expect(mapMollieSubscriptionStatus("completed")).toBe("canceled");
		expect(mapMollieSubscriptionStatus("active")).toBeNull();
		expect(mapMollieSubscriptionStatus("pending")).toBeNull();
	});
});
