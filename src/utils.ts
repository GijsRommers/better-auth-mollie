import type { GenericEndpointContext } from "better-auth";
import type { MollieInterval, MollieOptions, MolliePlan } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

const AMOUNT_PATTERN = /^\d+\.\d{2}$/;
const INTERVAL_PATTERN = /^(\d+) (day|days|week|weeks|month|months)$/;

export function isValidAmount(value: string): boolean {
	return AMOUNT_PATTERN.test(value);
}

export type ParsedInterval = { count: number; unit: "day" | "week" | "month" };

export function parseInterval(interval: MollieInterval | string): ParsedInterval {
	const match = INTERVAL_PATTERN.exec(interval);
	if (!match) {
		throw new Error(
			`Invalid Mollie interval "${interval}". Use e.g. "1 month", "12 months", "2 weeks" or "14 days".`,
		);
	}
	const count = Number(match[1]);
	const unit = match[2]!.replace(/s$/, "") as ParsedInterval["unit"];
	const max = unit === "month" ? 12 : unit === "week" ? 52 : 365;
	if (count < 1 || count > max) {
		throw new Error(`Invalid Mollie interval "${interval}": Mollie allows 1 to ${max} ${unit}s.`);
	}
	return { count, unit };
}

/**
 * Adds a Mollie interval to a date (UTC). Month arithmetic clamps to the last
 * day of the month, matching how Mollie schedules monthly charges.
 */
export function addInterval(date: Date, interval: MollieInterval | string): Date {
	const { count, unit } = parseInterval(interval);
	if (unit === "day") return new Date(date.getTime() + count * DAY_MS);
	if (unit === "week") return new Date(date.getTime() + count * 7 * DAY_MS);
	const result = new Date(date.getTime());
	const day = result.getUTCDate();
	result.setUTCDate(1);
	result.setUTCMonth(result.getUTCMonth() + count);
	const daysInMonth = new Date(
		Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
	).getUTCDate();
	result.setUTCDate(Math.min(day, daysInMonth));
	return result;
}

export function addDays(date: Date, days: number): Date {
	return new Date(date.getTime() + days * DAY_MS);
}

/**
 * Rounds up to the next UTC midnight (or returns the date itself if it is
 * already midnight). Used so Mollie never charges before a period ends.
 */
export function ceilToUTCDate(date: Date): Date {
	const floor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
	return new Date(floor === date.getTime() ? floor : floor + DAY_MS);
}

/** `YYYY-MM-DD` in UTC, the date format Mollie uses. */
export function toMollieDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Parses a Mollie `YYYY-MM-DD` date as UTC midnight. */
export function fromMollieDate(value: string): Date {
	return new Date(`${value}T00:00:00.000Z`);
}

export function getUrl(ctx: GenericEndpointContext, url: string): string {
	if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(url)) return url;
	return `${ctx.context.options.baseURL}${url.startsWith("/") ? url : `/${url}`}`;
}

export function getWebhookUrl(ctx: GenericEndpointContext, options: MollieOptions): string {
	return options.webhookUrl ?? `${ctx.context.baseURL}/mollie/webhook`;
}

export async function getPlans(options: MollieOptions): Promise<MolliePlan[]> {
	const subscription = options.subscription;
	if (!subscription?.enabled) return [];
	return typeof subscription.plans === "function" ? await subscription.plans() : subscription.plans;
}

export async function getPlanByName(
	options: MollieOptions,
	name: string,
): Promise<MolliePlan | undefined> {
	const plans = await getPlans(options);
	return plans.find((plan) => plan.name.toLowerCase() === name.toLowerCase());
}

export function planCurrency(plan: MolliePlan): string {
	return plan.currency ?? "EUR";
}

/**
 * Throws a descriptive error for an invalid plan list.
 */
export function validatePlans(plans: MolliePlan[]): void {
	const seen = new Set<string>();
	for (const plan of plans) {
		const key = plan.name.toLowerCase();
		if (!plan.name) throw new Error("Mollie plan is missing a name.");
		if (seen.has(key)) throw new Error(`Duplicate Mollie plan name "${plan.name}".`);
		seen.add(key);
		if (!isValidAmount(plan.amount) || Number(plan.amount) <= 0) {
			throw new Error(
				`Mollie plan "${plan.name}" has invalid amount "${plan.amount}". Use a positive decimal string with two decimals, e.g. "9.95".`,
			);
		}
		parseInterval(plan.interval);
		if (plan.freeTrial && (!Number.isInteger(plan.freeTrial.days) || plan.freeTrial.days < 1)) {
			throw new Error(`Mollie plan "${plan.name}" has an invalid freeTrial.days value.`);
		}
	}
}

/**
 * Shape of errors thrown by `@mollie/api-client`.
 */
export type MollieApiErrorLike = Error & { statusCode?: number; field?: string };

export function isMollieApiError(error: unknown): error is MollieApiErrorLike {
	return (
		error instanceof Error &&
		(error.name === "ApiError" || typeof (error as MollieApiErrorLike).statusCode === "number")
	);
}

export function isMollieNotFound(error: unknown): boolean {
	return isMollieApiError(error) && error.statusCode === 404;
}

/**
 * Statuses that prove Mollie rejected the request without performing it.
 * Deliberately excludes 400: Mollie also answers 400 when an idempotency key
 * is reused with different parameters, i.e. when the original request may
 * well have succeeded. 409, 429, 5xx and network errors are unknown too.
 */
const REJECTED_STATUSES = new Set([401, 403, 404, 410, 422]);

export function isRejectedMollieRequest(error: unknown): boolean {
	return (
		isMollieApiError(error) &&
		typeof error.statusCode === "number" &&
		REJECTED_STATUSES.has(error.statusCode)
	);
}

/** Mollie is still processing an earlier request with the same idempotency key. */
export function isMollieConflict(error: unknown): boolean {
	return isMollieApiError(error) && error.statusCode === 409;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Merges flat metadata objects for Mollie. `internal` (keys the plugin relies
 * on) always wins; prototype-polluting keys are dropped.
 */
export function mergeMetadata(
	internal: Record<string, unknown>,
	...sources: (Record<string, unknown> | null | undefined)[]
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			if (!UNSAFE_KEYS.has(key)) merged[key] = value;
		}
	}
	return { ...merged, ...internal };
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function toDate(value: string | null | undefined): Date | null {
	return value ? new Date(value) : null;
}
