import type { GenericEndpointContext } from "better-auth";
import { HIDE_METADATA } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx, originCheck } from "better-auth/api";
import * as z from "zod";
import {
	findSubscription,
	processMollieSubscription,
	processPayment,
	syncAllSubscriptions,
	syncSubscription,
} from "../billing";
import { MOLLIE_ERROR_CODES } from "../error-codes";
import { type BillingEvent, dispatchEvents } from "../events";
import { gatewayFor } from "../gateway";
import { OperationInProgressError, OperationSupersededError } from "../operations";
import { DEFAULT_GRACE_PERIOD_DAYS, hasSubscriptionAccess } from "../status";
import type { MollieOptions, Subscription } from "../types";
import { errorMessage, getUrl, isMollieNotFound } from "../utils";

const RESOURCE_ID = /^(tr|sub)_[A-Za-z0-9]+$/;

/**
 * Reads the resource id from a Mollie webhook body. Classic webhooks post
 * `id=tr_…` form-encoded; a JSON `{ "id": … }` body is accepted too. Nothing
 * else from the body is used.
 */
export function parseWebhookId(body: string): string | null {
	const text = body.trim();
	if (!text) return null;
	let id: unknown = null;
	if (text.startsWith("{")) {
		try {
			id = (JSON.parse(text) as { id?: unknown }).id;
		} catch {
			return null;
		}
	} else {
		id = new URLSearchParams(text).get("id");
	}
	return typeof id === "string" && RESOURCE_ID.test(id) ? id : null;
}

async function handleWebhookResource(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	id: string,
): Promise<BillingEvent[]> {
	const gateway = gatewayFor(options);
	if (id.startsWith("tr_")) {
		let payment: Awaited<ReturnType<typeof gateway.getPayment>>;
		try {
			payment = await gateway.getPayment(id);
		} catch (error) {
			if (isMollieNotFound(error)) return [];
			throw error;
		}
		const result = await processPayment(ctx, options, payment);
		if (result.ignored) ctx.context.logger.info(`[mollie] Webhook for ${id}: ${result.ignored}`);
		return result.events;
	}
	return processMollieSubscription(ctx, options, id);
}

/**
 * ### Endpoint
 *
 * POST `/mollie/webhook`
 *
 * Point Mollie here (the plugin sets it as `webhookUrl` on every payment and
 * subscription it creates). The body is never trusted: only the id is read,
 * and the payment or subscription is fetched from Mollie. Processing is
 * idempotent; hooks run in the background so the response is fast. Unknown
 * ids get `200` (as Mollie recommends); failures get `5xx`/`409` so Mollie
 * retries.
 */
export const mollieWebhook = (options: MollieOptions) =>
	createAuthEndpoint(
		"/mollie/webhook",
		{
			method: "POST",
			metadata: { ...HIDE_METADATA, openapi: { operationId: "handleMollieWebhook" } },
			cloneRequest: true,
			disableBody: true,
		},
		async (ctx) => {
			const raw = ctx.request ? await ctx.request.text() : "";
			const id = parseWebhookId(raw);
			if (!id) throw APIError.from("BAD_REQUEST", MOLLIE_ERROR_CODES.INVALID_WEBHOOK_PAYLOAD);
			let events: BillingEvent[];
			try {
				events = await handleWebhookResource(ctx, options, id);
			} catch (error) {
				if (
					error instanceof OperationInProgressError ||
					error instanceof OperationSupersededError
				) {
					throw APIError.from("CONFLICT", MOLLIE_ERROR_CODES.OPERATION_IN_PROGRESS);
				}
				ctx.context.logger.error(`[mollie] Webhook for ${id} failed: ${errorMessage(error)}`);
				throw APIError.from("INTERNAL_SERVER_ERROR", MOLLIE_ERROR_CODES.MOLLIE_WEBHOOK_ERROR);
			}
			dispatchEvents(ctx, options, events);
			return ctx.json({ received: true });
		},
	);

const subscriptionSuccessQuerySchema = z
	.object({
		callbackURL: z.string().optional(),
		subscriptionId: z.string().optional(),
	})
	.optional();

/**
 * ### Endpoint
 *
 * GET `/subscription/success`
 *
 * Mollie's `redirectUrl` after checkout. Syncs the first payment from Mollie
 * (the webhook may not have arrived yet) and then redirects to the
 * `successUrl` given to `subscription.upgrade`.
 */
export const subscriptionSuccess = (options: MollieOptions) =>
	createAuthEndpoint(
		"/subscription/success",
		{
			method: "GET",
			query: subscriptionSuccessQuerySchema,
			metadata: { ...HIDE_METADATA, openapi: { operationId: "handleSubscriptionSuccess" } },
			use: [originCheck((ctx) => ctx.query?.callbackURL)],
		},
		async (ctx) => {
			const callbackURL = ctx.query?.callbackURL || "/";
			const subscriptionId = ctx.query?.subscriptionId;
			const session = await getSessionFromCtx(ctx);
			if (subscriptionId && session) {
				try {
					const subscription = await findSubscription(ctx, [
						{ field: "id", value: subscriptionId },
					]);
					// Only for subscriptions the signed-in user may act on.
					const allowed =
						!!subscription &&
						(subscription.referenceId === session.user.id ||
							(options.subscription?.enabled &&
								(await options.subscription.authorizeReference?.(
									{
										user: session.user,
										session: session.session,
										referenceId: subscription.referenceId,
										action: "upgrade-subscription",
									},
									ctx,
								))) === true);
					if (
						subscription &&
						allowed &&
						["incomplete", "past_due", "unpaid"].includes(subscription.status)
					) {
						const { events } = await syncSubscription(ctx, options, subscription, new Date());
						dispatchEvents(ctx, options, events);
					}
				} catch (error) {
					ctx.context.logger.error(
						`[mollie] Sync after checkout for ${subscriptionId} failed: ${errorMessage(error)}`,
					);
				}
			}
			throw ctx.redirect(getUrl(ctx, callbackURL));
		},
	);

/**
 * Server only: `auth.api.hasActiveSubscription({ body: { referenceId } })`.
 *
 * Whether the reference currently has access: `trialing`/`active`, or
 * `past_due` within the grace period; a pending cancellation keeps access
 * until `periodEnd`. Reads the database only.
 */
export const hasActiveSubscriptionEndpoint = (options: MollieOptions) =>
	createAuthEndpoint(
		"/mollie/has-active-subscription",
		{
			method: "POST",
			body: z.object({ referenceId: z.string() }),
			metadata: { SERVER_ONLY: true as const },
		},
		async (ctx) => {
			const subscriptions = await ctx.context.adapter.findMany<Subscription>({
				model: "subscription",
				where: [{ field: "referenceId", value: ctx.body.referenceId }],
				sortBy: { field: "createdAt", direction: "desc" },
				limit: 100,
			});
			const gracePeriodDays = options.subscription?.enabled
				? (options.subscription.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS)
				: DEFAULT_GRACE_PERIOD_DAYS;
			const now = new Date();
			const subscription =
				subscriptions.find((s) => hasSubscriptionAccess(s, { now, gracePeriodDays })) ?? null;
			return ctx.json({ active: subscription !== null, subscription });
		},
	);

/**
 * Server only: `auth.api.syncMollieSubscriptions()`. Call it from your own
 * cron (e.g. hourly or daily). See `syncSubscription` for what is checked.
 */
export const syncMollieSubscriptionsEndpoint = (options: MollieOptions) =>
	createAuthEndpoint(
		"/mollie/sync",
		{
			method: "POST",
			body: z.object({ now: z.string().datetime().optional() }).optional(),
			metadata: { SERVER_ONLY: true as const },
		},
		async (ctx) => {
			const result = await syncAllSubscriptions(ctx, options, {
				now: ctx.body?.now ? new Date(ctx.body.now) : undefined,
				onEvents: (events) => dispatchEvents(ctx, options, events),
			});
			return ctx.json(result);
		},
	);
