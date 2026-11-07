import { describe, expect, it } from "vitest";
import {
	addInterval,
	ceilToUTCDate,
	fromMollieDate,
	isPubliclyReachable,
	isRejectedMollieRequest,
	isValidAmount,
	parseInterval,
	toMollieDate,
	validatePlans,
} from "../../src/utils";

describe("intervals", () => {
	it("parses Mollie interval strings", () => {
		expect(parseInterval("1 month")).toEqual({ count: 1, unit: "month" });
		expect(parseInterval("12 months")).toEqual({ count: 12, unit: "month" });
		expect(parseInterval("2 weeks")).toEqual({ count: 2, unit: "week" });
		expect(parseInterval("14 days")).toEqual({ count: 14, unit: "day" });
	});

	it("rejects intervals Mollie does not accept", () => {
		expect(() => parseInterval("13 months")).toThrow(/1 to 12/);
		expect(() => parseInterval("1 year")).toThrow(/Invalid Mollie interval/);
		expect(() => parseInterval("monthly")).toThrow(/Invalid Mollie interval/);
	});

	it("adds months and clamps to the end of shorter months", () => {
		const jan31 = new Date("2026-01-31T10:00:00Z");
		expect(addInterval(jan31, "1 month").toISOString()).toBe("2026-02-28T10:00:00.000Z");
		expect(addInterval(new Date("2028-01-31T00:00:00Z"), "1 month").toISOString()).toBe(
			"2028-02-29T00:00:00.000Z",
		);
		expect(addInterval(new Date("2026-03-15T00:00:00Z"), "12 months").toISOString()).toBe(
			"2027-03-15T00:00:00.000Z",
		);
	});

	it("adds days and weeks", () => {
		const start = new Date("2026-01-01T00:00:00Z");
		expect(addInterval(start, "14 days").toISOString()).toBe("2026-01-15T00:00:00.000Z");
		expect(addInterval(start, "2 weeks").toISOString()).toBe("2026-01-15T00:00:00.000Z");
	});
});

describe("dates", () => {
	it("rounds up to the next UTC midnight so Mollie never charges early", () => {
		expect(ceilToUTCDate(new Date("2026-01-01T00:00:00Z")).toISOString()).toBe(
			"2026-01-01T00:00:00.000Z",
		);
		expect(ceilToUTCDate(new Date("2026-01-01T00:00:00.001Z")).toISOString()).toBe(
			"2026-01-02T00:00:00.000Z",
		);
		expect(ceilToUTCDate(new Date("2026-12-31T23:30:00Z")).toISOString()).toBe(
			"2027-01-01T00:00:00.000Z",
		);
	});

	it("converts to and from Mollie dates", () => {
		expect(toMollieDate(new Date("2026-05-09T23:59:00Z"))).toBe("2026-05-09");
		expect(fromMollieDate("2026-05-09").toISOString()).toBe("2026-05-09T00:00:00.000Z");
	});
});

describe("amounts and plans", () => {
	it("validates Mollie amount strings", () => {
		expect(isValidAmount("9.95")).toBe(true);
		expect(isValidAmount("0.02")).toBe(true);
		expect(isValidAmount("10")).toBe(false);
		expect(isValidAmount("9.9")).toBe(false);
		expect(isValidAmount("9,95")).toBe(false);
	});

	it("validates plan lists", () => {
		expect(() =>
			validatePlans([
				{ name: "pro", amount: "9.95", interval: "1 month", freeTrial: { days: 14 } },
			]),
		).not.toThrow();
		expect(() =>
			validatePlans([
				{ name: "Pro", amount: "9.95", interval: "1 month" },
				{ name: "pro", amount: "99.00", interval: "12 months" },
			]),
		).toThrow(/Duplicate/);
		expect(() => validatePlans([{ name: "pro", amount: "9.9", interval: "1 month" }])).toThrow(
			/invalid amount/,
		);
		expect(() => validatePlans([{ name: "pro", amount: "0.00", interval: "1 month" }])).toThrow(
			/invalid amount/,
		);
		expect(() =>
			validatePlans([{ name: "pro", amount: "9.95", interval: "1 month", freeTrial: { days: 0 } }]),
		).toThrow(/freeTrial/);
	});
});

describe("isRejectedMollieRequest", () => {
	const apiError = (statusCode: number) =>
		Object.assign(new Error("mollie"), { name: "ApiError", statusCode });

	it("treats validation, auth and not-found errors as rejected", () => {
		for (const status of [401, 403, 404, 410, 422]) {
			expect(isRejectedMollieRequest(apiError(status))).toBe(true);
		}
	});

	it("does not treat 400 as rejected: it may be an idempotency-key mismatch", () => {
		expect(isRejectedMollieRequest(apiError(400))).toBe(false);
	});

	it("treats conflicts, rate limits, server and network errors as unknown outcomes", () => {
		expect(isRejectedMollieRequest(apiError(409))).toBe(false);
		expect(isRejectedMollieRequest(apiError(429))).toBe(false);
		expect(isRejectedMollieRequest(apiError(503))).toBe(false);
		expect(isRejectedMollieRequest(new TypeError("fetch failed"))).toBe(false);
	});
});

describe("isPubliclyReachable", () => {
	it("rejects hosts Mollie cannot call", () => {
		for (const url of [
			"http://localhost:5173/api/auth/mollie/webhook",
			"http://app.localhost/x",
			"http://127.0.0.1:3000/x",
			"http://10.0.0.5/x",
			"http://172.20.1.1/x",
			"http://192.168.1.10/x",
			"http://[::1]:3000/x",
			"http://[fd00::1]/x",
			"http://myhost.local/x",
			"not a url",
		]) {
			expect(isPubliclyReachable(url), url).toBe(false);
		}
	});

	it("accepts public hosts", () => {
		for (const url of [
			"https://example.com/api/auth/mollie/webhook",
			"https://abc123.ngrok.app/x",
			"http://172.32.0.1/x",
			"https://fcbarcelona.com/x",
		]) {
			expect(isPubliclyReachable(url), url).toBe(true);
		}
	});
});
