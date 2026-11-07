import type { RawError } from "better-auth";
import { APIError } from "better-auth/api";
import { MOLLIE_ERROR_CODES } from "./error-codes";
import { OperationInProgressError, OperationSupersededError } from "./operations";
import { errorMessage, isMollieApiError } from "./utils";

/**
 * A subscription's plan (or the plan it is scheduled to change to) is not in
 * the configuration: Mollie keeps billing it as it is, but the plugin cannot
 * bring Mollie in line with it. The sync reports it.
 */
export class PlanNotConfiguredError extends Error {
	readonly plan: string;
	constructor(plan: string, subscriptionId: string) {
		super(`Plan "${plan}" of ${subscriptionId} is not configured`);
		this.name = "PlanNotConfiguredError";
		this.plan = plan;
	}
}

/**
 * Converts an error from a Mollie call into an `APIError` for the client.
 * `APIError`s pass through unchanged.
 */
export function toAPIError(error: unknown, fallback: RawError): APIError {
	if (error instanceof APIError) return error;
	if (error instanceof OperationInProgressError || error instanceof OperationSupersededError) {
		return APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
	}
	if (isMollieApiError(error)) {
		return APIError.from("BAD_REQUEST", {
			code: fallback.code,
			message: `${fallback.message}: ${error.message}`,
		});
	}
	return APIError.from("INTERNAL_SERVER_ERROR", {
		code: fallback.code,
		message: `${fallback.message}: ${errorMessage(error)}`,
	});
}
