import type { GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, originCheck } from "better-auth/api";
import type { PaymentRequest } from "mollie-api-typescript/models";
import * as z from "zod";
import {
	cancelMollieSubscription,
	createScheduledSubscription,
	guardedUpdate,
	processPayment,
	recordPayment,
} from "../billing";
import { getOrCreateCustomer } from "../customer";
import { MOLLIE_ERROR_CODES } from "../error-codes";
import { toAPIError } from "../errors";
import { dispatchEvents } from "../events";
import { checkoutUrl, gatewayFor, metadataOf } from "../gateway";
import { mollieSessionMiddleware, referenceMiddleware } from "../middleware";
import { findByOperationKey, runOperation } from "../operations";
import {
	ACCESS_STATUSES,
	BILLING_STATUSES,
	DEFAULT_VERIFICATION_AMOUNT,
	isFinalPaymentStatus,
} from "../status";
import { chargeAmount, resolveTax, taxMetadata } from "../tax";
import type {
	CustomerType,
	MollieCtxSession,
	MollieOptions,
	MolliePaymentRecord,
	MolliePlan,
	Subscription,
	SubscriptionOptions,
} from "../types";
import {
	ceilToUTCDate,
	getPlanByName,
	getPlans,
	getUrl,
	getWebhookUrl,
	mergeMetadata,
	planCurrency,
	toMollieDate,
} from "../utils";

type ReferenceContext = { referenceId: string; customerType: CustomerType };

function subscriptionOptions(options: MollieOptions): SubscriptionOptions {
	return options.subscription as SubscriptionOptions;
}

/** Subscriptions of a reference, newest first. */
async function referenceSubscriptions(ctx: GenericEndpointContext, referenceId: string) {
	return ctx.context.adapter.findMany<Subscription>({
		model: "subscription",
		where: [{ field: "referenceId", value: referenceId }],
		sortBy: { field: "createdAt", direction: "desc" },
		limit: 100,
	});
}

/** `subscriptionId` may be the local id or the Mollie subscription id. */
function findTarget(subscriptions: Subscription[], subscriptionId: string | undefined) {
	if (!subscriptionId) return undefined;
	return subscriptions.find(
		(s) => s.id === subscriptionId || s.mollieSubscriptionId === subscriptionId,
	);
}

function withLimits(subscription: Subscription, plans: MolliePlan[]) {
	const plan = plans.find((p) => p.name.toLowerCase() === subscription.plan);
	return { ...subscription, limits: plan?.limits };
}

const PROTECTED_PAYMENT_KEYS = [
	"amount",
	"sequenceType",
	"customerId",
	"mandateId",
	"redirectUrl",
	"cancelUrl",
	"webhookUrl",
	"testmode",
] as const;

/**
 * Reuses a still-open checkout for the same plan and amount. Attempts that
 * changed state are processed on the way; if one was paid meanwhile (e.g. in
 * another tab), the subscription is active and no new checkout is needed.
 */
async function findOpenCheckout(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	subscription: Subscription,
	planName: string,
	amount: string,
): Promise<{ url?: string; activated?: boolean }> {
	const gateway = gatewayFor(options);
	const attempts = await ctx.context.adapter.findMany<MolliePaymentRecord>({
		model: "molliePayment",
		where: [
			{ field: "subscriptionId", value: subscription.id },
			{ field: "sequenceType", value: "first" },
		],
		limit: 100,
	});
	for (const attempt of attempts) {
		if (isFinalPaymentStatus(attempt.status)) continue;
		const payment = await gateway.getPayment(attempt.molliePaymentId);
		const url = checkoutUrl(payment);
		if (
			payment.status === "open" &&
			url &&
			payment.amount.value === amount &&
			metadataOf(payment).plan === planName
		) {
			return { url };
		}
		const result = await processPayment(ctx, options, payment);
		dispatchEvents(ctx, options, result.events);
		if (result.subscription && ACCESS_STATUSES.includes(result.subscription.status)) {
			return { activated: true };
		}
	}
	return {};
}

/**
 * Plan change without proration: stop the current Mollie subscription and
 * schedule a new one for the new plan from the end of the current period.
 * The plan (and its limits) change immediately.
 */
async function changePlan(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	current: Subscription,
	plan: MolliePlan,
	customerType: CustomerType,
) {
	if (!current.mollieCustomerId || !current.mollieMandateId) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.MANDATE_NOT_FOUND);
	}
	const now = new Date();
	const periodEnd = current.periodEnd ? new Date(current.periodEnd) : null;
	const startAt = periodEnd && periodEnd > now ? periodEnd : ceilToUTCDate(now);
	const tax = await resolveTax(ctx, options, {
		referenceId: current.referenceId,
		customerType,
		plan,
	});

	if (!current.cancelAtPeriodEnd) {
		try {
			await cancelMollieSubscription(ctx, options, current);
		} catch (error) {
			throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CANCEL_SUBSCRIPTION);
		}
	}
	let mollieSubscriptionId: string;
	try {
		mollieSubscriptionId = await createScheduledSubscription(ctx, options, {
			subscription: current,
			plan,
			mandateId: current.mollieMandateId,
			startAt,
			tax,
			scope: `subscription:${current.id}:change:${plan.name.toLowerCase()}:${toMollieDate(startAt)}:${chargeAmount(plan, tax)}:${current.mollieSubscriptionId}`,
		});
	} catch (error) {
		// The old Mollie subscription is gone: record that nothing renews.
		await guardedUpdate(ctx, current.id, ACCESS_STATUSES, { cancelAtPeriodEnd: true });
		throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_SUBSCRIPTION);
	}
	const updated = await guardedUpdate(ctx, current.id, ACCESS_STATUSES, {
		plan: plan.name.toLowerCase(),
		mollieSubscriptionId,
		cancelAtPeriodEnd: false,
	});
	if (!updated) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE);
	return updated;
}

/**
 * Undo a pending cancellation: a canceled Mollie subscription cannot be
 * resumed, so a new one is scheduled from the end of the current period.
 */
async function restore(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	subscription: Subscription,
	customerType: CustomerType,
) {
	if (!ACCESS_STATUSES.includes(subscription.status)) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE);
	}
	if (!subscription.cancelAtPeriodEnd) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_PENDING_CHANGE);
	}
	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
	if (!periodEnd || periodEnd <= new Date()) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_PERIOD_ENDED);
	}
	if (!subscription.mollieMandateId || !subscription.mollieCustomerId) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.MANDATE_NOT_FOUND);
	}
	const plan = await getPlanByName(options, subscription.plan);
	if (!plan) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_PLAN_NOT_FOUND);
	const tax = await resolveTax(ctx, options, {
		referenceId: subscription.referenceId,
		customerType,
		plan,
	});
	let mollieSubscriptionId: string;
	try {
		mollieSubscriptionId = await createScheduledSubscription(ctx, options, {
			subscription,
			plan,
			mandateId: subscription.mollieMandateId,
			startAt: periodEnd,
			tax,
			scope: `subscription:${subscription.id}:restore:${toMollieDate(periodEnd)}:${chargeAmount(plan, tax)}:${subscription.mollieSubscriptionId}`,
		});
	} catch (error) {
		throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_SUBSCRIPTION);
	}
	const updated = await guardedUpdate(
		ctx,
		subscription.id,
		ACCESS_STATUSES,
		{ cancelAtPeriodEnd: false, mollieSubscriptionId },
		[{ field: "cancelAtPeriodEnd", value: true }],
	);
	if (!updated) {
		// Ended or restored concurrently: undo the new Mollie subscription.
		await cancelMollieSubscription(ctx, options, {
			...subscription,
			mollieSubscriptionId,
		}).catch(() => {});
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE);
	}
	return updated;
}

const upgradeSubscriptionBodySchema = z.object({
	plan: z.string().meta({ description: 'The name of the plan to subscribe to. Eg: "pro"' }),
	referenceId: z
		.string()
		.meta({ description: 'Who is billed: an organization or user id. Eg: "org_123"' })
		.optional(),
	subscriptionId: z
		.string()
		.meta({ description: "Subscription to change (local id or Mollie subscription id)" })
		.optional(),
	customerType: z.enum(["user", "organization"]).optional(),
	metadata: z.record(z.string(), z.any()).optional(),
	locale: z.string().meta({ description: 'Mollie checkout locale. Eg: "nl_BE"' }).optional(),
	successUrl: z
		.string()
		.meta({ description: "Where to send the customer after checkout" })
		.default("/"),
	cancelUrl: z
		.string()
		.meta({ description: "Where to send the customer if they leave checkout" })
		.default("/"),
	returnUrl: z
		.string()
		.meta({ description: "Where to send the customer after a plan change" })
		.optional(),
	disableRedirect: z.boolean().default(false),
});

/**
 * ### Endpoint
 *
 * POST `/subscription/upgrade`
 *
 * ### API Methods
 *
 * **server:** `auth.api.upgradeSubscription`
 *
 * **client:** `authClient.subscription.upgrade`
 *
 * Starts a subscription (returns the Mollie checkout URL for the first
 * payment) or changes the plan of the current one (no proration; the new
 * price applies from the next period).
 */
export const upgradeSubscription = (options: MollieOptions) =>
	createAuthEndpoint(
		"/subscription/upgrade",
		{
			method: "POST",
			body: upgradeSubscriptionBodySchema,
			metadata: { openapi: { operationId: "upgradeSubscription" } },
			use: [
				mollieSessionMiddleware,
				referenceMiddleware(options, "upgrade-subscription"),
				originCheck((c) => [c.body.successUrl, c.body.cancelUrl, c.body.returnUrl]),
			],
		},
		async (ctx) => {
			const { user, session } = ctx.context.session as MollieCtxSession;
			const { referenceId, customerType } = ctx.context as unknown as ReferenceContext;
			const config = subscriptionOptions(options);
			const body = ctx.body;
			const respond = (url: string) =>
				ctx.json({ url: getUrl(ctx, url), redirect: !body.disableRedirect });

			if (config.requireEmailVerification && !user.emailVerified) {
				throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.EMAIL_VERIFICATION_REQUIRED);
			}
			const plan = await getPlanByName(options, body.plan);
			if (!plan) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_PLAN_NOT_FOUND);
			const planName = plan.name.toLowerCase();

			const subscriptions = await referenceSubscriptions(ctx, referenceId);
			const target = findTarget(subscriptions, body.subscriptionId);
			if (body.subscriptionId && !target) {
				throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_FOUND);
			}
			const current =
				target && ACCESS_STATUSES.includes(target.status)
					? target
					: subscriptions.find((s) => ACCESS_STATUSES.includes(s.status));

			if (current) {
				if (current.plan === planName) {
					if (!current.cancelAtPeriodEnd) {
						throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.ALREADY_SUBSCRIBED_PLAN);
					}
					await restore(ctx, options, current, customerType);
				} else {
					await changePlan(ctx, options, current, plan, customerType);
				}
				return respond(body.returnUrl ?? body.successUrl);
			}

			// New subscription: checkout for the first (mandate) payment.
			const customerId = await getOrCreateCustomer(ctx, options, { customerType, referenceId });
			const { adapter } = ctx.context;
			let row =
				target?.status === "incomplete"
					? target
					: subscriptions.find((s) => s.status === "incomplete");
			if (row) {
				if (row.plan !== planName || row.mollieCustomerId !== customerId) {
					row =
						(await adapter.update<Subscription>({
							model: "subscription",
							where: [{ field: "id", value: row.id }],
							update: { plan: planName, mollieCustomerId: customerId, updatedAt: new Date() },
						})) ?? row;
				}
			} else {
				row = await adapter.create<Omit<Subscription, "id">, Subscription>({
					model: "subscription",
					data: {
						referenceId,
						plan: planName,
						status: "incomplete",
						mollieCustomerId: customerId,
						cancelAtPeriodEnd: false,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});
			}

			const hadTrial = subscriptions.some((s) => s.trialEnd || s.status === "trialing");
			const trialDays = plan.freeTrial && !hadTrial ? plan.freeTrial.days : 0;
			const tax = await resolveTax(ctx, options, { referenceId, customerType, plan });
			const amount = trialDays
				? (config.verificationAmount ?? DEFAULT_VERIFICATION_AMOUNT)
				: chargeAmount(plan, tax);

			const open = await findOpenCheckout(ctx, options, row, planName, amount);
			if (open.activated) return respond(body.successUrl);
			if (open.url) return ctx.json({ url: open.url, redirect: !body.disableRedirect });

			const extra: Record<string, any> = {
				...((await config.getFirstPaymentParams?.(
					{ user, session, plan, subscription: row, isTrial: trialDays > 0 },
					ctx,
				)) ?? {}),
			};
			for (const key of PROTECTED_PAYMENT_KEYS) delete extra[key];
			const subscription = row;
			const redirectUrl = `${ctx.context.baseURL}/subscription/success?${new URLSearchParams({
				subscriptionId: subscription.id,
				callbackURL: body.successUrl,
			})}`;
			const gateway = gatewayFor(options);

			let payment: Awaited<ReturnType<typeof gateway.getPayment>>;
			try {
				const operation = await runOperation(ctx.context, {
					kind: "create_first_payment",
					referenceId,
					scope: `first-payment:${subscription.id}:${planName}:${amount}`,
					reuseSucceeded: false,
					execute: (idempotencyKey) =>
						gateway.createPayment(
							{
								...extra,
								description:
									extra.description ??
									(trialDays
										? `${plan.name}: payment method verification`
										: (plan.description ?? `${plan.name} subscription`)),
								amount: { currency: planCurrency(plan), value: amount },
								sequenceType: "first",
								customerId,
								redirectUrl,
								cancelUrl: getUrl(ctx, body.cancelUrl),
								webhookUrl: getWebhookUrl(ctx, options),
								...((body.locale ?? extra.locale)
									? { locale: (body.locale ?? extra.locale) as PaymentRequest["locale"] }
									: {}),
								metadata: mergeMetadata(
									{
										subscriptionId: subscription.id,
										referenceId,
										plan: planName,
										trial: trialDays > 0,
										trialDays,
										operationKey: idempotencyKey,
										...taxMetadata(tax),
									},
									body.metadata,
									extra.metadata,
								),
							} as PaymentRequest,
							idempotencyKey,
						),
					getId: (created) => created.id,
					recover: async (idempotencyKey) =>
						findByOperationKey(await gateway.listCustomerPayments(customerId), idempotencyKey),
				});
				payment = operation.result ?? (await gateway.getPayment(operation.mollieId));
			} catch (error) {
				ctx.context.logger.error("[mollie] Unable to create first payment", error);
				throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_PAYMENT);
			}
			await recordPayment(ctx, payment, subscription.id);
			const url = checkoutUrl(payment);
			if (!url) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_PAYMENT);
			return ctx.json({ url, redirect: !body.disableRedirect });
		},
	);

const cancelSubscriptionBodySchema = z.object({
	referenceId: z.string().optional(),
	subscriptionId: z
		.string()
		.meta({ description: "Subscription to cancel (local id or Mollie subscription id)" })
		.optional(),
	customerType: z.enum(["user", "organization"]).optional(),
	returnUrl: z.string().meta({ description: 'Where to send the customer next. Eg: "/account"' }),
	disableRedirect: z.boolean().default(false),
});

/**
 * ### Endpoint
 *
 * POST `/subscription/cancel`
 *
 * ### API Methods
 *
 * **server:** `auth.api.cancelSubscription`
 *
 * **client:** `authClient.subscription.cancel`
 *
 * Cancels at the end of the period: the Mollie subscription stops right away
 * (no further charges) and access continues until `periodEnd`.
 */
export const cancelSubscription = (options: MollieOptions) =>
	createAuthEndpoint(
		"/subscription/cancel",
		{
			method: "POST",
			body: cancelSubscriptionBodySchema,
			metadata: { openapi: { operationId: "cancelSubscription" } },
			use: [
				mollieSessionMiddleware,
				referenceMiddleware(options, "cancel-subscription"),
				originCheck((c) => c.body.returnUrl),
			],
		},
		async (ctx) => {
			const { referenceId } = ctx.context as unknown as ReferenceContext;
			const subscriptions = await referenceSubscriptions(ctx, referenceId);
			const subscription = ctx.body.subscriptionId
				? findTarget(subscriptions, ctx.body.subscriptionId)
				: (subscriptions.find((s) => BILLING_STATUSES.includes(s.status) && !s.cancelAtPeriodEnd) ??
					subscriptions.find((s) => BILLING_STATUSES.includes(s.status)));
			if (!subscription || !BILLING_STATUSES.includes(subscription.status)) {
				throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_FOUND);
			}
			if (!subscription.cancelAtPeriodEnd) {
				try {
					await cancelMollieSubscription(ctx, options, subscription);
				} catch (error) {
					throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CANCEL_SUBSCRIPTION);
				}
				await guardedUpdate(ctx, subscription.id, BILLING_STATUSES, { cancelAtPeriodEnd: true });
			}
			return ctx.json({
				url: getUrl(ctx, ctx.body.returnUrl),
				redirect: !ctx.body.disableRedirect,
			});
		},
	);

const restoreSubscriptionBodySchema = z.object({
	referenceId: z.string().optional(),
	subscriptionId: z
		.string()
		.meta({ description: "Subscription to restore (local id or Mollie subscription id)" })
		.optional(),
	customerType: z.enum(["user", "organization"]).optional(),
});

/**
 * ### Endpoint
 *
 * POST `/subscription/restore`
 *
 * ### API Methods
 *
 * **server:** `auth.api.restoreSubscription`
 *
 * **client:** `authClient.subscription.restore`
 *
 * Undoes a pending cancellation before the period ends.
 */
export const restoreSubscription = (options: MollieOptions) =>
	createAuthEndpoint(
		"/subscription/restore",
		{
			method: "POST",
			body: restoreSubscriptionBodySchema,
			metadata: { openapi: { operationId: "restoreSubscription" } },
			use: [mollieSessionMiddleware, referenceMiddleware(options, "restore-subscription")],
		},
		async (ctx) => {
			const { referenceId, customerType } = ctx.context as unknown as ReferenceContext;
			const subscriptions = await referenceSubscriptions(ctx, referenceId);
			const subscription = ctx.body.subscriptionId
				? findTarget(subscriptions, ctx.body.subscriptionId)
				: (subscriptions.find((s) => ACCESS_STATUSES.includes(s.status) && s.cancelAtPeriodEnd) ??
					subscriptions.find((s) => ACCESS_STATUSES.includes(s.status)));
			if (!subscription) {
				throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_FOUND);
			}
			const restored = await restore(ctx, options, subscription, customerType);
			return ctx.json(withLimits(restored, await getPlans(options)));
		},
	);

const listActiveSubscriptionsQuerySchema = z.optional(
	z.object({
		referenceId: z.string().optional(),
		customerType: z.enum(["user", "organization"]).optional(),
	}),
);

/**
 * ### Endpoint
 *
 * GET `/subscription/list`
 *
 * ### API Methods
 *
 * **server:** `auth.api.listActiveSubscriptions`
 *
 * **client:** `authClient.subscription.list`
 *
 * Subscriptions that are `trialing`, `active` or `past_due`, with plan limits.
 */
export const listActiveSubscriptions = (options: MollieOptions) =>
	createAuthEndpoint(
		"/subscription/list",
		{
			method: "GET",
			query: listActiveSubscriptionsQuerySchema,
			metadata: { openapi: { operationId: "listActiveSubscriptions" } },
			use: [mollieSessionMiddleware, referenceMiddleware(options, "list-subscription")],
		},
		async (ctx) => {
			const { referenceId } = ctx.context as unknown as ReferenceContext;
			const subscriptions = await referenceSubscriptions(ctx, referenceId);
			const plans = await getPlans(options);
			return ctx.json(
				subscriptions
					.filter((s) => ACCESS_STATUSES.includes(s.status))
					.map((s) => withLimits(s, plans)),
			);
		},
	);
