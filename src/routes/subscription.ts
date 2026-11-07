import type { GenericEndpointContext, Where } from "better-auth";
import { APIError, createAuthEndpoint, originCheck } from "better-auth/api";
import type { PaymentRequest } from "mollie-api-typescript/models";
import * as z from "zod";
import {
	checkoutScope,
	paymentPurpose,
	processPayment,
	reconcileRemote,
	recordPayment,
	refundUnappliedPayment,
	settleRecentCharges,
} from "../billing";
import { getOrCreateCustomer } from "../customer";
import { MOLLIE_ERROR_CODES } from "../error-codes";
import { toAPIError } from "../errors";
import { dispatchEvents } from "../events";
import { checkoutUrl, gatewayFor, metadataOf } from "../gateway";
import { billsIdentity, coverage, withReferenceLock } from "../identity";
import { type SubscriptionLock, withSubscriptionLock } from "../lock";
import { mollieSessionMiddleware, referenceMiddleware } from "../middleware";
import { type Fence, runOperation } from "../operations";
import {
	beforeCancellationTakesEffect,
	guardedUpdate,
	lockWaitMs,
	periodEndOf,
	reload,
	sameAppliedPayment,
	settlePreviousPayment,
} from "../rows";
import {
	ACCESS_STATUSES,
	BILLING_STATUSES,
	DEFAULT_VERIFICATION_AMOUNT,
	hasSubscriptionAccess,
	isFinalPaymentStatus,
} from "../status";
import { applyDueTransitions } from "../sync";
import { chargeAmount, fromCents, resolveTax, taxMetadata, toCents } from "../tax";
import type {
	CustomerType,
	FirstPaymentParams,
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

function subscriptionOptions(options: MollieOptions): SubscriptionOptions {
	return options.subscription as SubscriptionOptions;
}

/** Subscriptions of a billing identity (reference and customer type), newest first. */
async function referenceSubscriptions(
	ctx: GenericEndpointContext,
	identity: { referenceId: string; customerType: CustomerType },
) {
	const rows = await ctx.context.adapter.findMany<Subscription>({
		model: "subscription",
		where: [{ field: "referenceId", value: identity.referenceId }],
		sortBy: { field: "createdAt", direction: "desc" },
		limit: 100,
	});
	return rows.filter((row) => billsIdentity(row, identity));
}

/**
 * The reference's pending (`incomplete`) subscription row, or a new one:
 * under a lock per reference, so concurrent checkouts (also ones replacing an
 * expired row) share one row instead of each starting a subscription.
 */
async function pendingRow(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	data: Omit<Subscription, "id" | "status" | "createdAt" | "updatedAt"> & {
		customerType: CustomerType;
	},
): Promise<Subscription> {
	const identity = { referenceId: data.referenceId, customerType: data.customerType };
	return withReferenceLock(ctx, options, identity, async (fence) => {
		const existing = (await referenceSubscriptions(ctx, identity)).find(
			(s) => s.status === "incomplete",
		);
		if (existing) return existing;
		// Only while the lease holds: another request may create the row otherwise.
		await fence();
		return ctx.context.adapter.create<Omit<Subscription, "id">, Subscription>({
			model: "subscription",
			data: { ...data, status: "incomplete", createdAt: new Date(), updatedAt: new Date() },
		});
	}).catch((error: unknown) => {
		throw toAPIError(error, MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
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
] as const satisfies readonly (keyof PaymentRequest)[];

/**
 * Reuses a still-open checkout for the same plan, amount and purpose.
 * Attempts that changed state are processed on the way; if one was paid
 * meanwhile (e.g. in another tab), no new checkout is needed.
 */
async function findOpenCheckout(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	subscription: Subscription,
	match: {
		plan: string;
		amount: string;
		currency: string;
		purpose: PaymentPurpose;
		customerId: string;
	},
	lock: SubscriptionLock,
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
			payment.amount.currency === match.currency &&
			payment.customerId === match.customerId &&
			metadataOf(payment).plan === match.plan &&
			paymentPurpose(payment) === match.purpose
		) {
			return { url };
		}
		const result = await processPayment(ctx, options, payment, { lock, reconcile: true });
		dispatchEvents(ctx, options, result.events);
		if (result.subscription?.status === "active" || result.subscription?.status === "trialing") {
			return { activated: true };
		}
	}
	return {};
}

/**
 * Serializes changes to one subscription (plan change, cancel, restore) with
 * each other and with payment processing. `fn` gets the row as it is now.
 */
function lockSubscription<T>(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	subscription: Subscription,
	fn: (fresh: Subscription, lock: SubscriptionLock) => Promise<T>,
): Promise<T> {
	return withSubscriptionLock(
		ctx,
		subscription.id,
		async (lock) => {
			const fresh = await reload(ctx, subscription.id);
			if (!fresh) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_FOUND);
			return fn(fresh, lock);
		},
		{ waitMs: lockWaitMs(options) },
	).catch((error: unknown) => {
		throw toAPIError(error, MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
	});
}

/**
 * Runs `op` for a change that may undo the subscription's pending
 * cancellation (restore, a plan change): then under the billing identity's
 * lock, after checking that the period has not ended and that no other
 * subscription took over meanwhile (activation takes the same lock), so the
 * identity never ends up with two billing subscriptions.
 */
async function whileCancellationHolds<T>(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	subscription: Subscription,
	op: () => Promise<T>,
): Promise<T> {
	if (!subscription.cancelAtPeriodEnd) return op();
	const identity = {
		referenceId: subscription.referenceId,
		customerType: subscription.customerType ?? null,
	};
	return withReferenceLock(ctx, options, identity, async (fence) => {
		const now = new Date();
		const periodEnd = periodEndOf(subscription);
		if (!periodEnd || periodEnd <= now) {
			throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_PERIOD_ENDED);
		}
		const covered = await coverage(ctx, options, identity, subscription.id, now);
		if (covered === "covered") {
			throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.ANOTHER_SUBSCRIPTION_ACTIVE);
		}
		if (covered === "busy") {
			throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
		}
		await fence();
		return op();
	});
}

/** Guard for a row update: the row still points at the Mollie subscription we read. */
function sameRemote(subscription: Subscription): Where[] {
	return subscription.mollieSubscriptionId
		? [{ field: "mollieSubscriptionId", value: subscription.mollieSubscriptionId }]
		: [];
}

/**
 * After the row changed, make Mollie match it. A failure is logged, not
 * thrown: the change is recorded, and the next sync completes it before the
 * next payment date.
 */
async function applyToMollie(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	subscription: Subscription,
	lock: SubscriptionLock,
): Promise<Subscription> {
	try {
		return await reconcileRemote(ctx, options, subscription, new Date(), lock);
	} catch (error) {
		ctx.context.logger.error(
			`[mollie] ${subscription.id} changed; Mollie will be updated by the next sync: ${errorMessage(error)}`,
		);
		return subscription;
	}
}

/** When the next period starts (the end of the current one, or now if it already ended). */
function nextPeriodStart(subscription: Subscription, now: Date): Date {
	const periodEnd = periodEndOf(subscription);
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
 * of the subscription (no checkout). The charge belongs to this upgrade
 * attempt only: it counts once the upgrade records it as the applied payment,
 * and is refunded otherwise (see `applyProration`).
 */
async function chargeProration(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	current: Subscription,
	plan: MolliePlan,
	customerType: CustomerType,
	cents: number,
	fence: Fence,
) {
	const customerId = current.mollieCustomerId;
	const mandateId = current.mollieMandateId;
	if (!customerId || !mandateId) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.MANDATE_NOT_FOUND);
	}
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
	// The tax callback may be slow: prove the lock is still ours right before charging.
	await fence();
	const chargeOnce = async (scope: string) => {
		const operation = await runOperation(ctx.context, {
			kind: "create_proration_payment",
			referenceId: current.referenceId,
			scope,
			reuseSucceeded: true,
			execute: (idempotencyKey) =>
				gateway.createPayment(
					{
						amount: { currency: planCurrency(plan), value: amount },
						description: `${plan.name}: upgrade for the rest of this period`,
						sequenceType: "recurring",
						customerId,
						mandateId,
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
	};
	// Each upgrade attempt charges its own payment, never one made by another
	// attempt (that attempt may still refund it). An attempt that lost its
	// lock leaves its charge unapplied, and it is refunded.
	const attempt = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12);
	try {
		return await chargeOnce(`proration:${current.id}:${planName}:${periodEnd}:${attempt}`);
	} catch (error) {
		throw toAPIError(error, MOLLIE_ERROR_CODES.UNABLE_TO_CREATE_PAYMENT);
	}
}

/**
 * Changes the plan of a running subscription (caller holds the lock):
 * - during a trial: right away, nothing to charge;
 * - upgrade (same interval and currency, higher price): right away, and the
 *   pro-rata difference for the rest of the period is charged now;
 * - anything else (downgrade, other interval): from the next period, kept in
 *   `pendingPlan` until then.
 * The row is updated first; Mollie then bills the new plan from the next
 * period (`reconcileRemote`).
 */
async function changePlan(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	initial: Subscription,
	plan: MolliePlan,
	customerType: CustomerType,
	lock: SubscriptionLock,
) {
	// Charges Mollie finished but whose webhook is late (a renewal) change
	// the period this change is priced and scheduled from: apply them first.
	const charges = await settleRecentCharges(ctx, options, initial, { lock });
	if (charges.inProgress) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.PAYMENT_IN_PROGRESS);
	}
	const current = charges.processed ? await reload(ctx, initial.id) : initial;
	if (!current || !ACCESS_STATUSES.includes(current.status)) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE);
	}
	const now = new Date();
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
		await lock.fence();
		const updated = await guardedUpdate(
			ctx,
			current.id,
			ACCESS_STATUSES,
			{ pendingPlan: planName, cancelAtPeriodEnd: false },
			[...sameRemote(current), ...beforeCancellationTakesEffect(current)],
			{ mollieSync: true, lock },
		);
		if (!updated) throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
		return applyToMollie(ctx, options, updated, lock);
	}

	const cents = mode === "upgrade" && oldPlan ? prorationCents(current, oldPlan, plan, now) : 0;
	// Charged first: if Mollie refuses the charge, nothing has changed yet.
	const proration =
		cents > 0
			? await chargeProration(ctx, options, current, plan, customerType, cents, lock.fence)
			: null;
	const compensate = async () => {
		if (!proration) return;
		dispatchEvents(ctx, options, await refundUnappliedPayment(ctx, options, current, proration));
	};
	await lock.fence().catch(async (error: unknown) => {
		await compensate();
		throw error;
	});
	// The charge is recorded as the applied payment in the same update as the
	// new plan: a charge without its upgrade is refunded (see processPayment).
	if (proration) await settlePreviousPayment(ctx, current, proration);
	const updated = await guardedUpdate(
		ctx,
		current.id,
		ACCESS_STATUSES,
		{
			plan: planName,
			pendingPlan: null,
			cancelAtPeriodEnd: false,
			...(proration ? { appliedPaymentId: proration.id } : {}),
		},
		[
			...sameRemote(current),
			...beforeCancellationTakesEffect(current),
			...(proration ? sameAppliedPayment(current) : []),
		],
		{ mollieSync: true, lock },
	);
	if (!updated) {
		await compensate();
		throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
	}
	if (proration) {
		const result = await processPayment(ctx, options, proration, { lock });
		dispatchEvents(ctx, options, result.events);
	}
	return applyToMollie(ctx, options, updated, lock);
}

/** Undo a scheduled plan change: keep billing the current plan (caller holds the lock). */
async function cancelPendingChange(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	current: Subscription,
	lock: SubscriptionLock,
) {
	await lock.fence();
	const updated = await guardedUpdate(
		ctx,
		current.id,
		ACCESS_STATUSES,
		{ pendingPlan: null, cancelAtPeriodEnd: false },
		[...sameRemote(current), ...beforeCancellationTakesEffect(current)],
		{ mollieSync: true, lock },
	);
	if (!updated) throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
	return applyToMollie(ctx, options, updated, lock);
}

/**
 * Undo a pending cancellation before the period ends (caller holds the
 * lock). A canceled Mollie subscription cannot be resumed, so
 * `reconcileRemote` schedules a new one from the end of the period.
 */
async function restore(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	subscription: Subscription,
	lock: SubscriptionLock,
) {
	if (!ACCESS_STATUSES.includes(subscription.status)) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE);
	}
	if (!subscription.cancelAtPeriodEnd) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_PENDING_CHANGE);
	}
	const periodEnd = periodEndOf(subscription);
	if (!periodEnd || periodEnd <= new Date()) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_PERIOD_ENDED);
	}
	if (!subscription.mollieMandateId || !subscription.mollieCustomerId) {
		throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.MANDATE_NOT_FOUND);
	}
	await lock.fence();
	const updated = await guardedUpdate(
		ctx,
		subscription.id,
		ACCESS_STATUSES,
		{ cancelAtPeriodEnd: false, pendingPlan: null },
		[
			{ field: "cancelAtPeriodEnd", value: true },
			...sameRemote(subscription),
			...beforeCancellationTakesEffect(subscription),
		],
		{ mollieSync: true, lock },
	);
	if (!updated) throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
	return applyToMollie(ctx, options, updated, lock);
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
 * payment), restarts a delinquent one (a recovery checkout), or changes the
 * plan of the current one: an upgrade applies right away and charges the
 * pro-rata difference; anything else from the next period (see `changePlan`).
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
			const { referenceId, customerType } = ctx.context;
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

			const subscriptions = await referenceSubscriptions(ctx, { referenceId, customerType });
			const target = findTarget(subscriptions, body.subscriptionId);
			if (body.subscriptionId && !target) {
				throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_FOUND);
			}
			let current =
				target && BILLING_STATUSES.includes(target.status)
					? target
					: subscriptions.find((s) => BILLING_STATUSES.includes(s.status));
			if (current) {
				// A period that ended (e.g. after a cancellation) ends the subscription
				// first; then this request starts a new one.
				const timed = await applyDueTransitions(
					ctx,
					options,
					current,
					new Date(),
					lockWaitMs(options),
				);
				dispatchEvents(ctx, options, timed.events);
				current = BILLING_STATUSES.includes(timed.subscription.status)
					? timed.subscription
					: undefined;
			}

			/**
			 * Issues (or reuses) a checkout for `candidate`, under its lock and on
			 * the row as it is now, so it is serialized with the payments that
			 * activate it and with the sync that expires it.
			 */
			const checkout = async (
				candidate: Subscription,
				input: { purpose: PaymentPurpose; trialDays: number; customerId: string },
			): ReturnType<typeof respond> => {
				const tax = await resolveTax(ctx, options, { referenceId, customerType, plan });
				const amount =
					input.purpose === "verification"
						? (config.verificationAmount ?? DEFAULT_VERIFICATION_AMOUNT)
						: chargeAmount(plan, tax);
				const recovery = input.purpose === "recovery";
				const settled = (row: Subscription) =>
					recovery
						? (row.status !== "past_due" && row.status !== "unpaid") || !!row.cancelAtPeriodEnd
						: row.status === "active" || row.status === "trialing";
				// Either the response, or the new row to start over on.
				type Issued = { response: ReturnType<typeof respond> } | { restart: Subscription };
				const issue = async (fresh: Subscription, lock: SubscriptionLock): Promise<Issued> => {
					let row = fresh;
					// Activated (another tab, the webhook) or recovered meanwhile.
					if (settled(row)) return { response: respond(body.successUrl) };
					if (row.status === "incomplete") {
						const differs =
							row.plan !== planName ||
							row.mollieCustomerId !== input.customerId ||
							row.customerType !== customerType;
						if (differs) {
							const updated = await guardedUpdate(
								ctx,
								row.id,
								["incomplete"],
								{ plan: planName, mollieCustomerId: input.customerId, customerType },
								[],
								{ lock },
							);
							if (!updated) {
								throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
							}
							row = updated;
						}
					}
					if (row.status === "incomplete" || recovery) {
						const open = await findOpenCheckout(
							ctx,
							options,
							row,
							{
								plan: planName,
								amount,
								currency: planCurrency(plan),
								purpose: input.purpose,
								customerId: input.customerId,
							},
							lock,
						);
						if (open.activated) return { response: respond(body.successUrl) };
						if (open.url) {
							return { response: ctx.json({ url: open.url, redirect: !body.disableRedirect }) };
						}
						// Processing earlier attempts may have moved the row on.
						row = (await reload(ctx, row.id)) ?? row;
						if (settled(row)) return { response: respond(body.successUrl) };
					}
					if (!recovery && row.status !== "incomplete") {
						// The checkout expired meanwhile: start over on a new row, under
						// that row's own lock.
						return {
							restart: await pendingRow(ctx, options, {
								referenceId,
								plan: planName,
								mollieCustomerId: input.customerId,
								customerType,
								cancelAtPeriodEnd: false,
							}),
						};
					}
					await lock.fence();
					const url = await createCheckout(ctx, options, {
						row,
						fence: lock.fence,
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
					return { response: ctx.json({ url, redirect: !body.disableRedirect }) };
				};
				const issued = await lockSubscription(ctx, options, candidate, issue);
				return "restart" in issued ? checkout(issued.restart, input) : issued.response;
			};

			if (current) {
				// Payment failed and was not recovered: pay again with a new card or
				// mandate to restart the subscription.
				if (current.status === "past_due" || current.status === "unpaid") {
					if (current.cancelAtPeriodEnd) {
						throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE);
					}
					// Mollie may still be retrying the failed charge, or a retry was
					// paid but not processed yet; paying twice is never right.
					const charges = await settleRecentCharges(ctx, options, current);
					if (charges.inProgress) {
						throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.PAYMENT_IN_PROGRESS);
					}
					if (charges.processed) {
						const latest = await reload(ctx, current.id);
						if (latest?.status !== "past_due" && latest?.status !== "unpaid") {
							return respond(body.successUrl);
						}
					}
					const customerId =
						current.mollieCustomerId ??
						(await getOrCreateCustomer(ctx, options, { customerType, referenceId }));
					return checkout(current, { purpose: "recovery", trialDays: 0, customerId });
				}
				await lockSubscription(ctx, options, current, async (fresh, lock) => {
					if (!ACCESS_STATUSES.includes(fresh.status)) {
						throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_ACTIVE);
					}
					if (fresh.plan === planName) {
						if (fresh.pendingPlan) {
							return whileCancellationHolds(ctx, options, fresh, () =>
								cancelPendingChange(ctx, options, fresh, lock),
							);
						}
						if (fresh.cancelAtPeriodEnd) {
							return whileCancellationHolds(ctx, options, fresh, () =>
								restore(ctx, options, fresh, lock),
							);
						}
						throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.ALREADY_SUBSCRIBED_PLAN);
					}
					if (fresh.pendingPlan === planName && !fresh.cancelAtPeriodEnd) return fresh;
					return whileCancellationHolds(ctx, options, fresh, () =>
						changePlan(ctx, options, fresh, plan, customerType, lock),
					);
				});
				return respond(body.returnUrl ?? body.successUrl);
			}

			// New subscription: checkout for the first (mandate) payment.
			const customerId = await getOrCreateCustomer(ctx, options, { customerType, referenceId });
			// Reuse the pending row (updated under its lock in `checkout`), or start one.
			let row =
				target?.status === "incomplete"
					? target
					: subscriptions.find((s) => s.status === "incomplete");
			if (!row) {
				row = await pendingRow(ctx, options, {
					referenceId,
					plan: planName,
					mollieCustomerId: customerId,
					customerType,
					cancelAtPeriodEnd: false,
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
		/** Of the row's lock: checked again right before Mollie is called. */
		fence: Fence;
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
	const extra: FirstPaymentParams = {
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
	// The type leaves these out, but a cast could still smuggle them in.
	for (const key of PROTECTED_PAYMENT_KEYS) delete (extra as Record<string, unknown>)[key];
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

	// `getFirstPaymentParams` or the journal may have taken long enough for
	// the lock to be lost (and the row to change, e.g. expire): then no
	// checkout for it. Checked before the journal and right before Mollie.
	await input.fence();
	let payment: Awaited<ReturnType<typeof gateway.getPayment>>;
	try {
		const operation = await runOperation(ctx.context, {
			kind: "create_first_payment",
			referenceId,
			// Everything the checkout charges: an attempt recovered from the
			// journal must be for this very price.
			scope: `${checkoutScope(purpose, row.id)}${planName}:${amount}:${planCurrency(plan)}`,
			reuseSucceeded: false,
			execute: async (idempotencyKey) => {
				await input.fence();
				return gateway.createPayment(
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
					},
					idempotencyKey,
				);
			},
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
			const { referenceId, customerType } = ctx.context;
			const subscriptions = await referenceSubscriptions(ctx, { referenceId, customerType });
			const subscription = ctx.body.subscriptionId
				? findTarget(subscriptions, ctx.body.subscriptionId)
				: (subscriptions.find((s) => BILLING_STATUSES.includes(s.status) && !s.cancelAtPeriodEnd) ??
					subscriptions.find((s) => BILLING_STATUSES.includes(s.status)));
			if (!subscription || !BILLING_STATUSES.includes(subscription.status)) {
				throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_FOUND);
			}
			if (!subscription.cancelAtPeriodEnd) {
				await lockSubscription(ctx, options, subscription, async (fresh, lock) => {
					if (fresh.cancelAtPeriodEnd || !BILLING_STATUSES.includes(fresh.status)) return;
					// The cancellation is recorded first, so it can never be lost: if
					// stopping the Mollie subscription fails or is interrupted, the
					// next webhook or sync finishes it.
					await lock.fence();
					const updated = await guardedUpdate(
						ctx,
						fresh.id,
						BILLING_STATUSES,
						{ cancelAtPeriodEnd: true, pendingPlan: null },
						sameRemote(fresh),
						{ mollieSync: true, lock },
					);
					if (!updated) throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
					await applyToMollie(ctx, options, updated, lock);
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
			const { referenceId, customerType } = ctx.context;
			const subscriptions = await referenceSubscriptions(ctx, { referenceId, customerType });
			const subscription = ctx.body.subscriptionId
				? findTarget(subscriptions, ctx.body.subscriptionId)
				: (subscriptions.find((s) => ACCESS_STATUSES.includes(s.status) && s.cancelAtPeriodEnd) ??
					subscriptions.find((s) => ACCESS_STATUSES.includes(s.status)));
			if (!subscription) {
				throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.SUBSCRIPTION_NOT_FOUND);
			}
			const restored = await lockSubscription(ctx, options, subscription, (fresh, lock) =>
				whileCancellationHolds(ctx, options, fresh, () => restore(ctx, options, fresh, lock)),
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
			const { referenceId, customerType } = ctx.context;
			const now = new Date();
			const subscriptions: Subscription[] = [];
			// Apply clock-based changes (period ended, scheduled plan change) so
			// the answer is right even before the app's cron has run.
			for (const subscription of await referenceSubscriptions(ctx, { referenceId, customerType })) {
				// Without waiting: a busy subscription is listed as it is.
				const timed = await applyDueTransitions(ctx, options, subscription, now, 0);
				dispatchEvents(ctx, options, timed.events);
				subscriptions.push(timed.subscription);
			}
			const plans = await getPlans(options);
			return ctx.json(
				subscriptions
					// Date-aware: a past-due subscription beyond its grace period (not
					// marked unpaid yet by the sync) is not listed as having access.
					.filter((s) =>
						hasSubscriptionAccess(s, {
							now,
							gracePeriodDays: subscriptionOptions(options).gracePeriodDays,
						}),
					)
					.map((s) => withLimits(s, plans)),
			);
		},
	);
