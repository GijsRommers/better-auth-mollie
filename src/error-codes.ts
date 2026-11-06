import { defineErrorCodes } from "better-auth";

/**
 * Error codes returned by the Mollie plugin.
 *
 * Names intentionally match `@better-auth/stripe` where the meaning is the
 * same, so client code that switches on `error.code` keeps working.
 */
export const MOLLIE_ERROR_CODES = defineErrorCodes({
	UNAUTHORIZED: "Unauthorized access",
	INVALID_REQUEST_BODY: "Invalid request body",
	SUBSCRIPTION_NOT_FOUND: "Subscription not found",
	SUBSCRIPTION_PLAN_NOT_FOUND: "Subscription plan not found",
	ALREADY_SUBSCRIBED_PLAN: "You're already subscribed to this plan",
	REFERENCE_ID_NOT_ALLOWED: "Reference id is not allowed",
	CUSTOMER_NOT_FOUND: "Mollie customer not found for this reference",
	UNABLE_TO_CREATE_CUSTOMER: "Unable to create Mollie customer",
	UNABLE_TO_CREATE_PAYMENT: "Unable to create Mollie payment",
	UNABLE_TO_CREATE_SUBSCRIPTION: "Unable to create Mollie subscription",
	UNABLE_TO_CANCEL_SUBSCRIPTION: "Unable to cancel Mollie subscription",
	MANDATE_NOT_FOUND: "No Mollie mandate is available for this subscription",
	OPERATION_IN_PROGRESS:
		"Another billing operation for this subscription is in progress. Retry in a moment.",
	EMAIL_VERIFICATION_REQUIRED: "Email verification is required before you can subscribe to a plan",
	SUBSCRIPTION_NOT_ACTIVE: "Subscription is not active",
	SUBSCRIPTION_NOT_PENDING_CHANGE: "Subscription has no pending cancellation",
	SUBSCRIPTION_PERIOD_ENDED: "The subscription period has already ended",
	ORGANIZATION_NOT_FOUND: "Organization not found",
	ORGANIZATION_SUBSCRIPTION_NOT_ENABLED: "Organization subscription is not enabled",
	AUTHORIZE_REFERENCE_REQUIRED:
		"Organization subscriptions require authorizeReference callback to be configured",
	ORGANIZATION_HAS_ACTIVE_SUBSCRIPTION: "Cannot delete organization with active subscription",
	ORGANIZATION_REFERENCE_ID_REQUIRED:
		"Reference ID is required. Provide referenceId or set activeOrganizationId in session",
	INVALID_WEBHOOK_PAYLOAD: "Invalid Mollie webhook payload",
	MOLLIE_WEBHOOK_ERROR: "Mollie webhook error",
});
