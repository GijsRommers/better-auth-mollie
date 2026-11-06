import { APIError, createAuthMiddleware, sessionMiddleware } from "better-auth/api";
import { MOLLIE_ERROR_CODES } from "./error-codes";
import { isOrganizationBillingEnabled } from "./schema";
import type {
	AuthorizeReferenceAction,
	CustomerType,
	MollieCtxSession,
	MollieOptions,
	SubscriptionOptions,
} from "./types";

export const mollieSessionMiddleware = createAuthMiddleware(
	{ use: [sessionMiddleware] },
	async (ctx) => {
		return { session: ctx.context.session as MollieCtxSession };
	},
);

/**
 * Resolves who is billed (`referenceId` + `customerType`) and checks the
 * signed-in user may act on it.
 *
 * - `customerType` comes from the request, else `subscription.customerType`
 *   (default `"organization"`).
 * - Organization billing uses `referenceId`, else the active organization.
 *   Without either, and when the request did not ask for organization billing
 *   explicitly, it falls back to billing the user.
 * - `authorizeReference` must approve every organization reference and any
 *   user reference other than the signed-in user.
 */
export const referenceMiddleware = (options: MollieOptions, action: AuthorizeReferenceAction) =>
	createAuthMiddleware(async (ctx) => {
		const ctxSession = ctx.context.session as MollieCtxSession | undefined;
		if (!ctxSession) throw APIError.from("UNAUTHORIZED", MOLLIE_ERROR_CODES.UNAUTHORIZED);
		const subscriptionOptions = options.subscription as SubscriptionOptions;
		const requested = (ctx.body?.customerType ?? ctx.query?.customerType) as
			| CustomerType
			| undefined;
		const explicitReferenceId = (ctx.body?.referenceId ?? ctx.query?.referenceId) as
			| string
			| undefined;
		const customerType = requested ?? subscriptionOptions.customerType ?? "organization";
		const { user, session } = ctxSession;

		const authorize = async (referenceId: string) => {
			if (!subscriptionOptions.authorizeReference) return false;
			return subscriptionOptions.authorizeReference(
				{ user, session, referenceId, action },
				ctx as never,
			);
		};

		if (customerType === "organization") {
			const referenceId = explicitReferenceId || session.activeOrganizationId || undefined;
			if (referenceId || requested === "organization") {
				if (!isOrganizationBillingEnabled(options)) {
					throw APIError.from(
						"BAD_REQUEST",
						MOLLIE_ERROR_CODES.ORGANIZATION_SUBSCRIPTION_NOT_ENABLED,
					);
				}
				if (!subscriptionOptions.authorizeReference) {
					throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.AUTHORIZE_REFERENCE_REQUIRED);
				}
				if (!referenceId) {
					throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.ORGANIZATION_REFERENCE_ID_REQUIRED);
				}
				if (!(await authorize(referenceId))) {
					throw APIError.from("UNAUTHORIZED", MOLLIE_ERROR_CODES.UNAUTHORIZED);
				}
				return { referenceId, customerType: "organization" as CustomerType };
			}
			// No organization in play: bill the user.
		}

		const referenceId = explicitReferenceId || user.id;
		if (referenceId === user.id) {
			return { referenceId, customerType: "user" as CustomerType };
		}
		if (!subscriptionOptions.authorizeReference) {
			throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.REFERENCE_ID_NOT_ALLOWED);
		}
		if (!(await authorize(referenceId))) {
			throw APIError.from("UNAUTHORIZED", MOLLIE_ERROR_CODES.UNAUTHORIZED);
		}
		return { referenceId, customerType: "user" as CustomerType };
	});
