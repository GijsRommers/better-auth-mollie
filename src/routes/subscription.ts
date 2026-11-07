import type { GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, originCheck } from "better-auth/api";
import type { PaymentRequest } from "mollie-api-typescript/models";
import * as z from "zod";
import {
	applyTimeTransitions,
	cancelMollieSubscription,
	createScheduledSubscription,
	findSubscription,
	guardedUpdate,
	paymentPurpose,
	processPayment,
	recordPayment,
} from "../billing";
import { getOrCreateCustomer } from "../customer";
import { MOLLIE_ERROR_CODES } from "../error-codes";
import { toAPIError } from "../errors";
import { dispatchEvents } from "../events";
import { checkoutUrl, gatewayFor, metadataOf } from "../gateway";
import { mollieSessionMiddleware, referenceMiddleware } from "../middleware";
import { runOperation, withLock } from "../operations";
import {
	ACCESS_STATUSES,
	BILLING_STATUSES,
	DEFAULT_VERIFICATION_AMOUNT,
	isFinalPaymentStatus,
} from "../status";
import { chargeAmount, fromCents, resolveTax, taxMetadata, toCents } from "../tax";
import type {
	CustomerType,
	MollieCtxSession,
	MollieOptions,
	MolliePaymentRecord,
	MolliePlan,
	PaymentPurpose,
	Subscription,
	SubscriptionOptions,
	TaxBreakdown,
} from "../types";
import {
	ceilToUTCDate,
	errorMessage,
	getPlanByName,
	getPlans,
	getUrl,
	getWebhookUrl,
	mergeMetadata,
	parseInterval,
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
 * Reuses a still-open checkout for the same plan, amount and purpose.
 * Attempts that changed state are processed on the way; if one was paid
 * meanwhile (e.g. in another tab), no new checkout is needed.
 */
async function findOpenCheckout(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	subscription: Subscription,
	match: { plan: string; amount: string; purpose: PaymentPurpose },
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
			payment.amount.value === match.amount &&
			metadataOf(payment).plan === match.plan &&
			paymentPurpose(payment) === match.purpose
		) {
			return { url };
		}
		const result = await processPayment(ctx, options, payment);
		dispatchEvents(ctx, options, result.events);
		if (result.subscription?.status === "active" || result.subscription?.status === "trialing") {
			return { activated: true };
		}
	}
	return {};
}

/**
 * Makes `mollieSubscriptionId` the subscription's Mollie subscription, but
 * only if the row still points at the one this change started from. If a
 * concurrent change won, the new Mollie subscription is canceled again,
 * unless the winner adopted that very same one (identical request).
 */
async function adopt(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	current: Subscription,
	mollieSubscriptionId: string,
	set: Partial<Subscription>,
): Promise<Subscription> {
	const updated = await guardedUpdate(
		ctx,
		current.id,
		ACCESS_STATUSES,
		{ ...set, mollieSubscriptionId },
		current.mollieSubscriptionId
			? [{ field: "mollieSubscriptionId", value: current.mollieSubscriptionId }]
			: [],
	);
	if (updated) return updated;
	const latest = await findSubscription(ctx, [{ field: "id", value: current.id }]);
	if (latest?.mollieSubscriptionId === mollieSubscriptionId) return latest;
	await cancelMollieSubscription(ctx, options, { ...current, mollieSubscriptionId }).catch(
		(error: unknown) =>
			ctx.context.logger.error(
				`[mollie] Could not cancel unadopted subscription ${mollieSubscriptionId}: ${errorMessage(error)}`,
			),
	);
	throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
}

/** Serializes changes to one subscription (plan change, cancel, restore). */
function lockSubscription<T>(
	ctx: GenericEndpointContext,
	subscription: Subscription,
	fn: (fresh: Subscription) => Promise<T>,
): Promise<T> {
	return withLock(
		ctx.context,
		{ key: `lock:subscription:${subscription.id}`, referenceId: subscription.referenceId },
		async () => {
			const fresh = await findSubscription(ctx, [{ field: "id", value: subscription.id }]);
			if (!fresh) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_FOUND);
			return fn(fresh);
		},
	).catch((error: unknown) => {
		throw toAPIError(error, MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
	});
}

/**
 * Points billing at `plan` from `startAt`: stops the current Mollie
 * subscription (if still running) and creates a new one. If the new one
 * cannot be created, the subscription is marked to end at `periodEnd`,
 * which is the truth at that point.
 */
async function reschedule(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	current: Subscription,
	input: { plan: MolliePlan; customerType: CustomerType; startAt: Date; tag: string },
): Promise<string> {
	const { plan, customerType, startAt, tag } = input;
	if (!current.mollieCustomerId || !current.mollieMandateId) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.MANDATE_NOT_FOUND);
	}
	const tax = await resolveTax(ctx, options, {
		referenceId: current.referenceId,
		customerType,
		plan,
	});
	if (current.mollieSubscriptionId && !current.cancelAtPeriodEnd) {
		try {
			await cancelMollieSubscription(ctx, options, current);
		} catch (error) {
			throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CANCEL_SUBSCRIPTION);
		}
	}
	try {
		return await createScheduledSubscription(ctx, options, {
			subscription: current,
			plan,
			mandateId: current.mollieMandateId,
			startAt,
			tax,
			scope: `subscription:${current.id}:${tag}:${plan.name.toLowerCase()}:${toMollieDate(startAt)}:${chargeAmount(plan, tax)}:${current.mollieSubscriptionId}`,
		});
	} catch (error) {
		await guardedUpdate(
			ctx,
			current.id,
			BILLING_STATUSES,
			{ cancelAtPeriodEnd: true, pendingPlan: null },
			current.mollieSubscriptionId
				? [{ field: "mollieSubscriptionId", value: current.mollieSubscriptionId }]
				: [],
		);
		throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_SUBSCRIPTION);
	}
}

/** When the next period starts (the end of the current one, or now if it already ended). */
function nextPeriodStart(subscription: Subscription, now: Date): Date {
	const periodEnd = subscription.periodEnd ? new Date(subscription.periodEnd) : null;
	return periodEnd && periodEnd > now ? periodEnd : ceilToUTCDate(now);
}

/**
 * The pro-rata price difference (in cents, before VAT) for the rest of the
 * current period when moving from `from` to `to`.
 */
export function prorationCents(
	subscription: Subscription,
	from: MolliePlan,
	to: MolliePlan,
	now: Date,
) {
	const start = subscription.periodStart ? new Date(subscription.periodStart).getTime() : null;
	const end = subscription.periodEnd ? new Date(subscription.periodEnd).getTime() : null;
	if (start === null || end === null || end <= start || end <= now.getTime()) return 0;
	const remaining = Math.min(1, Math.max(0, (end - now.getTime()) / (end - start)));
	return Math.max(0, Math.round((toCents(to.amount) - toCents(from.amount)) * remaining));
}

/**
 * Charges the pro-rata difference of an upgrade right away, on the mandate
 * of the subscription (no checkout). One charge per plan per period.
 */
async function chargeProration(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	current: Subscription,
	plan: MolliePlan,
	customerType: CustomerType,
	cents: number,
) {
	const customerId = current.mollieCustomerId as string;
	const planName = plan.name.toLowerCase();
	const net = fromCents(cents);
	const tax = await resolveTax(
		ctx,
		options,
		{ referenceId: current.referenceId, customerType, plan },
		net,
	);
	const amount = tax?.gross ?? net;
	const periodEnd = toMollieDate(nextPeriodStart(current, new Date()));
	const gateway = gatewayFor(options);
	try {
		const operation = await runOperation(ctx.context, {
			kind: "create_proration_payment",
			referenceId: current.referenceId,
			scope: `proration:${current.id}:${planName}:${periodEnd}`,
			reuseSucceeded: true,
			execute: (idempotencyKey) =>
				gateway.createPayment(
					{
						amount: { currency: planCurrency(plan), value: amount },
						description: `${plan.name}: upgrade for the rest of this period`,
						sequenceType: "recurring",
						customerId,
						mandateId: current.mollieMandateId as string,
						webhookUrl: getWebhookUrl(ctx, options),
						metadata: {
							subscriptionId: current.id,
							referenceId: current.referenceId,
							plan: planName,
							purpose: "proration",
							operationKey: idempotencyKey,
							...taxMetadata(tax),
						},
					},
					idempotencyKey,
				),
			getId: (created) => created.id,
			recover: (idempotencyKey, attempt) =>
				gateway.findCustomerPaymentByOperationKey(customerId, idempotencyKey, attempt.createdAt),
		});
		const payment = operation.result ?? (await gateway.getPayment(operation.mollieId));
		await recordPayment(ctx, payment, current.id);
		return payment;
	} catch (error) {
		throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_PAYMENT);
	}
}

/**
 * Changes the plan of a running subscription:
 * - during a trial: right away, nothing to charge;
 * - upgrade (same interval and currency, higher price): right away, and the
 *   pro-rata difference for the rest of the period is charged now;
 * - anything else (downgrade, other interval): from the next period, kept in
 *   `pendingPlan` until then.
 * In every case Mollie bills the new plan from the next period.
 */
async function changePlan(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	current: Subscription,
	plan: MolliePlan,
	customerType: CustomerType,
) {
	const now = new Date();
	const startAt = nextPeriodStart(current, now);
	const planName = plan.name.toLowerCase();
	const oldPlan = await getPlanByName(options, current.plan);
	const sameTerms =
		!!oldPlan &&
		planCurrency(oldPlan) === planCurrency(plan) &&
		JSON.stringify(parseInterval(oldPlan.interval)) ===
			JSON.stringify(parseInterval(plan.interval));
	const mode =
		current.status === "trialing"
			? "switch"
			: sameTerms && oldPlan && toCents(plan.amount) > toCents(oldPlan.amount)
				? "upgrade"
				: "schedule";

	if (mode === "schedule") {
		const mollieSubscriptionId = await reschedule(ctx, options, current, {
			plan,
			customerType,
			startAt,
			tag: "change",
		});
		return adopt(ctx, options, current, mollieSubscriptionId, {
			pendingPlan: planName,
			cancelAtPeriodEnd: false,
		});
	}

	const cents = mode === "upgrade" && oldPlan ? prorationCents(current, oldPlan, plan, now) : 0;
	const proration =
		cents > 0 ? await chargeProration(ctx, options, current, plan, customerType, cents) : null;
	let mollieSubscriptionId: string;
	try {
		mollieSubscriptionId = await reschedule(ctx, options, current, {
			plan,
			customerType,
			startAt,
			tag: "change",
		});
	} catch (error) {
		// Already charged for the upgrade: grant it, even though renewal failed.
		if (proration) {
			await guardedUpdate(ctx, current.id, ACCESS_STATUSES, { plan: planName, pendingPlan: null });
		}
		throw error;
	}
	const updated = await adopt(ctx, options, current, mollieSubscriptionId, {
		plan: planName,
		pendingPlan: null,
		cancelAtPeriodEnd: false,
	});
	if (proration) {
		const result = await processPayment(ctx, options, proration);
		dispatchEvents(ctx, options, result.events);
	}
	return updated;
}

/** Undo a scheduled plan change: keep billing the current plan. */
async function cancelPendingChange(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	current: Subscription,
	customerType: CustomerType,
) {
	const plan = await getPlanByName(options, current.plan);
	if (!plan) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_PLAN_NOT_FOUND);
	const mollieSubscriptionId = await reschedule(ctx, options, current, {
		plan,
		customerType,
		startAt: nextPeriodStart(current, new Date()),
		tag: "keep",
	});
	return adopt(ctx, options, current, mollieSubscriptionId, {
		pendingPlan: null,
		cancelAtPeriodEnd: false,
	});
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
	return adopt(ctx, options, subscription, mollieSubscriptionId, {
		cancelAtPeriodEnd: false,
		pendingPlan: null,
	});
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
				target && BILLING_STATUSES.includes(target.status)
					? target
					: subscriptions.find((s) => BILLING_STATUSES.includes(s.status));

			const checkout = async (
				row: Subscription,
				input: { purpose: PaymentPurpose; trialDays: number; customerId: string },
			) => {
				const tax = await resolveTax(ctx, options, { referenceId, customerType, plan });
				const amount =
					input.purpose === "verification"
						? (config.verificationAmount ?? DEFAULT_VERIFICATION_AMOUNT)
						: chargeAmount(plan, tax);
				const open = await findOpenCheckout(ctx, options, row, {
					plan: planName,
					amount,
					purpose: input.purpose,
				});
				if (open.activated) return respond(body.successUrl);
				if (open.url) return ctx.json({ url: open.url, redirect: !body.disableRedirect });
				// Processing earlier attempts may have moved the row on.
				let target = (await findSubscription(ctx, [{ field: "id", value: row.id }])) ?? row;
				if (input.purpose === "recovery") {
					if (target.status !== "past_due" && target.status !== "unpaid") {
						return respond(body.successUrl);
					}
				} else if (target.status !== "incomplete") {
					target = await ctx.context.adapter.create<Omit<Subscription, "id">, Subscription>({
						model: "subscription",
						data: {
							referenceId,
							plan: planName,
							status: "incomplete",
							mollieCustomerId: input.customerId,
							cancelAtPeriodEnd: false,
							createdAt: new Date(),
							updatedAt: new Date(),
						},
					});
				}
				const url = await createCheckout(ctx, options, {
					row: target,
					plan,
					amount,
					tax,
					purpose: input.purpose,
					trialDays: input.trialDays,
					customerId: input.customerId,
					referenceId,
					body,
					user,
					session,
				});
				return ctx.json({ url, redirect: !body.disableRedirect });
			};

			if (current) {
				// Payment failed and was not recovered: pay again with a new card or
				// mandate to restart the subscription.
				if (current.status === "past_due" || current.status === "unpaid") {
					const customerId =
						current.mollieCustomerId ??
						(await getOrCreateCustomer(ctx, options, { customerType, referenceId }));
					return checkout(current, { purpose: "recovery", trialDays: 0, customerId });
				}
				await lockSubscription(ctx, current, async (fresh) => {
					if (!ACCESS_STATUSES.includes(fresh.status)) {
						throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE);
					}
					if (fresh.plan === planName) {
						if (fresh.pendingPlan) return cancelPendingChange(ctx, options, fresh, customerType);
						if (fresh.cancelAtPeriodEnd) return restore(ctx, options, fresh, customerType);
						throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.ALREADY_SUBSCRIBED_PLAN);
					}
					if (fresh.pendingPlan === planName && !fresh.cancelAtPeriodEnd) return fresh;
					return changePlan(ctx, options, fresh, plan, customerType);
				});
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
			return checkout(row, {
				purpose: trialDays ? "verification" : "checkout",
				trialDays,
				customerId,
			});
		},
	);

/**
 * Creates the first payment (`sequenceType: "first"`, so it creates a
 * mandate) through the journal and returns its checkout URL.
 */
async function createCheckout(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	input: {
		row: Subscription;
		plan: MolliePlan;
		amount: string;
		tax: TaxBreakdown | null;
		purpose: PaymentPurpose;
		trialDays: number;
		customerId: string;
		referenceId: string;
		body: z.infer<typeof upgradeSubscriptionBodySchema>;
		user: MollieCtxSession["user"];
		session: MollieCtxSession["session"];
	},
): Promise<string> {
	const { row, plan, amount, tax, purpose, trialDays, customerId, referenceId, body } = input;
	const config = subscriptionOptions(options);
	const planName = plan.name.toLowerCase();
	const extra: Record<string, any> = {
		...((await config.getFirstPaymentParams?.(
			{
				user: input.user,
				session: input.session,
				plan,
				subscription: row,
				isTrial: purpose === "verification",
			},
			ctx,
		)) ?? {}),
	};
	for (const key of PROTECTED_PAYMENT_KEYS) delete extra[key];
	const redirectUrl = `${ctx.context.baseURL}/subscription/success?${new URLSearchParams({
		subscriptionId: row.id,
		callbackURL: body.successUrl,
	})}`;
	const description =
		extra.description ??
		(purpose === "verification"
			? `${plan.name}: payment method verification`
			: (plan.description ?? `${plan.name} subscription`));
	const locale = body.locale ?? extra.locale;
	const gateway = gatewayFor(options);

	let payment: Awaited<ReturnType<typeof gateway.getPayment>>;
	try {
		const operation = await runOperation(ctx.context, {
			kind: "create_first_payment",
			referenceId,
			scope: `${purpose === "recovery" ? "recovery" : "first-payment"}:${row.id}:${planName}:${amount}`,
			reuseSucceeded: false,
			execute: (idempotencyKey) =>
				gateway.createPayment(
					{
						...extra,
						description,
						amount: { currency: planCurrency(plan), value: amount },
						sequenceType: "first",
						customerId,
						redirectUrl,
						cancelUrl: getUrl(ctx, body.cancelUrl),
						webhookUrl: getWebhookUrl(ctx, options),
						...(locale ? { locale: locale as PaymentRequest["locale"] } : {}),
						metadata: mergeMetadata(
							{
								subscriptionId: row.id,
								referenceId,
								plan: planName,
								purpose,
								trial: purpose === "verification",
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
			recover: (idempotencyKey, attempt) =>
				gateway.findCustomerPaymentByOperationKey(customerId, idempotencyKey, attempt.createdAt),
		});
		payment = operation.result ?? (await gateway.getPayment(operation.mollieId));
	} catch (error) {
		ctx.context.logger.error("[mollie] Unable to create first payment", error);
		throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_PAYMENT);
	}
	await recordPayment(ctx, payment, row.id);
	const url = checkoutUrl(payment);
	if (!url) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_PAYMENT);
	return url;
}

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
				await lockSubscription(ctx, subscription, async (fresh) => {
					if (fresh.cancelAtPeriodEnd || !BILLING_STATUSES.includes(fresh.status)) return;
					try {
						await cancelMollieSubscription(ctx, options, fresh);
					} catch (error) {
						throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CANCEL_SUBSCRIPTION);
					}
					await guardedUpdate(
						ctx,
						fresh.id,
						BILLING_STATUSES,
						{ cancelAtPeriodEnd: true, pendingPlan: null },
						fresh.mollieSubscriptionId
							? [{ field: "mollieSubscriptionId", value: fresh.mollieSubscriptionId }]
							: [],
					);
				});
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
			const restored = await lockSubscription(ctx, subscription, (fresh) =>
				restore(ctx, options, fresh, customerType),
			);
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
			const now = new Date();
			const subscriptions: Subscription[] = [];
			// Apply clock-based changes (period ended, scheduled plan change) so
			// the answer is right even before the app's cron has run.
			for (const subscription of await referenceSubscriptions(ctx, referenceId)) {
				const timed = await applyTimeTransitions(ctx, options, subscription, now);
				dispatchEvents(ctx, options, timed.events);
				subscriptions.push(timed.subscription);
			}
			const plans = await getPlans(options);
			return ctx.json(
				subscriptions
					.filter((s) => ACCESS_STATUSES.includes(s.status))
					.map((s) => withLimits(s, plans)),
			);
		},
	);
