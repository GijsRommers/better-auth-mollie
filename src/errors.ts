import type { RawError } from "better-auth";
import { APIError } from "better-auth/api";
import { MOLLIE_ERROR_CODES } from "./error-codes";
import { OperationInProgressError, OperationSupersededError } from "./operations";
import { errorMessage, isMollieApiError } from "./utils";

export { InvalidPlansError, PlanConfigurationError, PlanNotConfiguredError } from "./plan-errors";

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
