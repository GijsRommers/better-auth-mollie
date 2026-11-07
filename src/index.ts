import type { AuthContext, BetterAuthPlugin, GenericEndpointContext, User } from "better-auth";
import { APIError } from "better-auth/api";
import { getOrCreateCustomer, syncCustomerDetails } from "./customer";
import { MOLLIE_ERROR_CODES } from "./error-codes";
import {
	hasActiveSubscriptionEndpoint,
	mollieWebhook,
	subscriptionSuccess,
	syncMollieSubscriptionsEndpoint,
} from "./routes/mollie";
import {
	cancelSubscription,
	listActiveSubscriptions,
	restoreSubscription,
	upgradeSubscription,
} from "./routes/subscription";
import {
	getSchema,
	isOrganizationBillingEnabled,
	type mollieOperationSchema,
	type molliePaymentSchema,
	type organizationSchema,
	type subscriptionSchema,
	type userSchema,
} from "./schema";
import { BILLING_STATUSES } from "./status";
import type { SyncResult } from "./sync";
import type { CustomerType, MollieOptions, Subscription, WithMollieCustomerId } from "./types";
import { errorMessage, isValidAmount, validatePlans } from "./utils";
import { PACKAGE_VERSION } from "./version";

/** Throws early, at startup, for configurations that cannot work. */
function validateOptions(options: MollieOptions): void {
	const fail = (message: string): never => {
		throw new Error(`[better-auth-mollie] ${message}`);
	};
	if (!options.mollieClient) fail("`mollieClient` is required.");
	const subscription = options.subscription;
	if (subscription?.enabled) {
		if (Array.isArray(subscription.plans)) validatePlans(subscription.plans);
		if (
			subscription.verificationAmount !== undefined &&
			!isValidAmount(subscription.verificationAmount)
		) {
			fail('`subscription.verificationAmount` must be a decimal string like "0.02".');
		}
		if (subscription.gracePeriodDays !== undefined && subscription.gracePeriodDays < 0) {
			fail("`subscription.gracePeriodDays` cannot be negative.");
		}
		const customerType = subscription.customerType ?? "organization";
		if (customerType === "organization" && options.organization?.enabled === false) {
			fail(
				'`subscription.customerType` is "organization" (the default) but `organization.enabled` is false. Set `subscription.customerType: "user"` for per-user billing.',
			);
		}
		if (isOrganizationBillingEnabled(options) && !subscription.authorizeReference) {
			fail(
				'Organization billing requires `subscription.authorizeReference` (decide who may manage an organization\'s subscription). For per-user billing set `subscription.customerType: "user"`.',
			);
		}
	}
	if (options.salesInvoices?.enabled) {
		if (!options.salesInvoices.getRecipient) {
			fail("`salesInvoices.getRecipient` is required when sales invoices are enabled.");
		}
		const taxed = options.subscription?.enabled && !!options.subscription.tax;
		if (!taxed && !options.salesInvoices.vatRate) {
			fail(
				'Sales invoices need a VAT rate: configure `subscription.tax` (e.g. euVat()) or set `salesInvoices.vatRate` (e.g. "21.00").',
			);
		}
	}
}

type OrganizationHookData = { organization: { id: string; name: string } & WithMollieCustomerId };

function installOrganizationHooks(ctx: AuthContext, options: MollieOptions) {
	const organizationPlugin = ctx.getPlugin("organization" as never) as
		| { options: { organizationHooks?: Record<string, any> } }
		| undefined
		| null;
	if (!organizationPlugin) {
		ctx.logger.error(
			'[mollie] Organization billing is enabled but the organization plugin is not installed. Add `organization()` to your plugins, or set `subscription.customerType: "user"`.',
		);
		return;
	}
	const existing = organizationPlugin.options.organizationHooks ?? {};

	/** Block deleting an organization whose subscription will still be charged. */
	const beforeDelete = async (data: OrganizationHookData, hookCtx?: unknown) => {
		const billing = await ctx.adapter.findMany<Subscription>({
			model: "subscription",
			where: [
				{ field: "referenceId", value: data.organization.id },
				{ field: "status", operator: "in", value: [...BILLING_STATUSES] },
			],
			limit: 100,
		});
		if (billing.some((s) => !s.cancelAtPeriodEnd)) {
			// Better Auth clears the active organization before this hook runs.
			// The organization stays, so put the user back where they were.
			const session = (hookCtx as GenericEndpointContext | undefined)?.context?.session?.session as
				| { token: string; activeOrganizationId?: string | null }
				| undefined;
			if (session?.activeOrganizationId === data.organization.id) {
				await ctx.internalAdapter
					.updateSession(session.token, { activeOrganizationId: data.organization.id } as never)
					.catch(() => {});
			}
			throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.ORGANIZATION_HAS_ACTIVE_SUBSCRIPTION);
		}
	};

	/** Keep the Mollie customer name in sync with the organization. */
	const afterUpdate = async (data: OrganizationHookData) => {
		const { organization } = data;
		if (!organization?.mollieCustomerId) return;
		ctx.runInBackground(
			syncCustomerDetails(ctx, options, "organization", organization.id).catch((error: unknown) =>
				ctx.logger.error(`[mollie] Could not sync organization name: ${errorMessage(error)}`),
			),
		);
	};

	organizationPlugin.options.organizationHooks = {
		...existing,
		beforeDeleteOrganization: async (data: OrganizationHookData, hookCtx?: unknown) => {
			await existing.beforeDeleteOrganization?.(data, hookCtx);
			await beforeDelete(data, hookCtx);
		},
		afterUpdateOrganization: async (data: OrganizationHookData, hookCtx?: unknown) => {
			await existing.afterUpdateOrganization?.(data, hookCtx);
			await afterUpdate(data);
		},
	};
}

type SubscriptionEndpoints = {
	upgradeSubscription: ReturnType<typeof upgradeSubscription>;
	cancelSubscription: ReturnType<typeof cancelSubscription>;
	restoreSubscription: ReturnType<typeof restoreSubscription>;
	listActiveSubscriptions: ReturnType<typeof listActiveSubscriptions>;
	subscriptionSuccess: ReturnType<typeof subscriptionSuccess>;
	hasActiveSubscription: ReturnType<typeof hasActiveSubscriptionEndpoint>;
	syncMollieSubscriptions: ReturnType<typeof syncMollieSubscriptionsEndpoint>;
};

type MollieSchema<O extends MollieOptions> = typeof userSchema &
	typeof mollieOperationSchema &
	typeof organizationSchema &
	(O["subscription"] extends { enabled: true }
		? typeof subscriptionSchema & typeof molliePaymentSchema
		: Record<never, never>);

/**
 * Mollie subscriptions for Better Auth.
 *
 * @see https://github.com/GijsRommers/better-auth-mollie
 */
export const mollie = <O extends MollieOptions>(options: O) => {
	validateOptions(options);
	const subscriptionEndpoints: SubscriptionEndpoints = {
		upgradeSubscription: upgradeSubscription(options),
		cancelSubscription: cancelSubscription(options),
		restoreSubscription: restoreSubscription(options),
		listActiveSubscriptions: listActiveSubscriptions(options),
		subscriptionSuccess: subscriptionSuccess(options),
		hasActiveSubscription: hasActiveSubscriptionEndpoint(options),
		syncMollieSubscriptions: syncMollieSubscriptionsEndpoint(options),
	};

	return {
		id: "mollie",
		version: PACKAGE_VERSION,
		endpoints: {
			mollieWebhook: mollieWebhook(options),
			...(options.subscription?.enabled ? subscriptionEndpoints : {}),
		} as { mollieWebhook: ReturnType<typeof mollieWebhook> } & (O["subscription"] extends {
			enabled: true;
		}
			? SubscriptionEndpoints
			: Record<never, never>),
		init(ctx: AuthContext) {
			if ((ctx.adapter as { id?: string }).id === "memory") {
				ctx.logger.warn(
					"[mollie] The memory adapter does not enforce unique fields, which the plugin's locks rely on: concurrent requests are not safe. Use it for development and tests only.",
				);
			}
			const subscription = options.subscription;
			if (subscription?.enabled && typeof subscription.plans === "function") {
				Promise.resolve(subscription.plans())
					.then(validatePlans)
					.catch((error: unknown) =>
						ctx.logger.error(`[mollie] Invalid plans: ${errorMessage(error)}`),
					);
			}
			if (subscription?.enabled && isOrganizationBillingEnabled(options)) {
				installOrganizationHooks(ctx, options);
			}
			return {
				options: {
					databaseHooks: {
						user: {
							create: {
								async after(created: User, hookCtx: GenericEndpointContext | null) {
									if (!options.createCustomerOnSignUp || !hookCtx) return;
									try {
										await getOrCreateCustomer(hookCtx, options, {
											customerType: "user",
											referenceId: created.id,
										});
									} catch (error) {
										ctx.logger.error(
											`[mollie] Could not create customer on sign-up: ${errorMessage(error)}`,
										);
									}
								},
							},
							update: {
								async after(updated: User & WithMollieCustomerId) {
									if (!updated.mollieCustomerId) return;
									ctx.runInBackground(
										syncCustomerDetails(ctx, options, "user", updated.id).catch((error: unknown) =>
											ctx.logger.error(
												`[mollie] Could not sync customer details: ${errorMessage(error)}`,
											),
										),
									);
								},
							},
						},
					},
				},
			};
		},
		schema: getSchema(options) as unknown as MollieSchema<O>,
		options: options as NoInfer<O>,
		$ERROR_CODES: MOLLIE_ERROR_CODES,
	} satisfies BetterAuthPlugin;
};

export type MolliePlugin<O extends MollieOptions> = ReturnType<typeof mollie<O>>;

type AuthWithMollie = {
	api: {
		hasActiveSubscription: (input: {
			body: { referenceId: string };
		}) => Promise<{ active: boolean; subscription: Subscription | null }>;
		syncMollieSubscriptions: (input: { body: { now?: string } }) => Promise<SyncResult>;
	};
};

/**
 * Whether `referenceId` (an organization or user id) currently has access:
 * `trialing`/`active`, or `past_due` within the grace period. A pending
 * cancellation keeps access until the end of the period. Reads the database
 * only, so it is cheap to call on every request.
 */
export async function hasActiveSubscription(
	auth: AuthWithMollie,
	referenceId: string,
): Promise<boolean> {
	const result = await auth.api.hasActiveSubscription({ body: { referenceId } });
	return result.active;
}

/**
 * Re-checks subscriptions against Mollie and the clock. Run it from your own
 * cron, e.g. hourly. Stable subscriptions are only fetched from Mollie around
 * their next payment date.
 *
 * With `referenceId`, only that user's or organization's subscriptions are
 * synced, and each is checked at Mollie right away: for a "refresh" button
 * in your support tools, or after changing something by hand.
 */
export function syncMollieSubscriptions(
	auth: AuthWithMollie,
	options: { now?: Date; referenceId?: string; customerType?: CustomerType } = {},
): Promise<SyncResult> {
	return auth.api.syncMollieSubscriptions({
		body: {
			...(options.now ? { now: options.now.toISOString() } : {}),
			...(options.referenceId !== undefined ? { referenceId: options.referenceId } : {}),
			...(options.customerType ? { customerType: options.customerType } : {}),
		},
	});
}

export { MOLLIE_ERROR_CODES } from "./error-codes";
export {
	mollieOperationSchema,
	molliePaymentSchema,
	organizationSchema,
	subscriptionSchema,
	userSchema,
} from "./schema";
export { accessDeadline, hasSubscriptionAccess } from "./status";
export type { SyncResult } from "./sync";
export { computeTax } from "./tax";
export type * from "./types";
