import type { Client } from "mollie-api-typescript";
import type {
	EntityCustomer,
	ListPaymentResponse,
	ListSubscriptionResponse,
	PaymentRequest,
	PaymentResponse,
	SalesInvoiceRequest,
	SalesInvoiceResponse,
	SubscriptionRequest,
	SubscriptionResponse,
} from "mollie-api-typescript/models";

/** A Mollie payment as returned by `payments.get` or a list endpoint. */
export type MolliePayment = PaymentResponse | ListPaymentResponse;
/** A Mollie subscription as returned by `subscriptions.get` or a list endpoint. */
export type MollieSubscription = SubscriptionResponse | ListSubscriptionResponse;

/** The SDK sets no request timeout of its own. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How far before an attempt's journal timestamp a recovery scan keeps
 * looking, to absorb clock differences between this server and Mollie.
 */
const RECOVERY_SLACK_MS = 60 * 60 * 1000;

const PAGE_LIMIT = 250;

type Listed = { id: string; metadata?: unknown; createdAt?: string | null };

/** Payment metadata as a plain object (Mollie allows strings and arrays too). */
export function metadataOf(resource: { metadata?: unknown }): Record<string, unknown> {
	const metadata = resource.metadata;
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: {};
}

/**
 * Finds the resource whose metadata carries `operationKey` in a newest-first
 * list. Pages until it is found, the list ends, or the page reaches resources
 * created well before `since` (they cannot belong to the attempt). An error
 * while paging propagates, so an incomplete search never counts as "absent".
 */
async function scanForOperationKey<P>(
	pages: AsyncIterable<P>,
	items: (page: P) => Listed[] | undefined,
	operationKey: string,
	since: Date,
	usable: (item: Listed) => boolean = () => true,
): Promise<string | null> {
	const cutoff = since.getTime() - RECOVERY_SLACK_MS;
	for await (const page of pages) {
		const list = items(page) ?? [];
		for (const item of list) {
			if (metadataOf(item).operationKey === operationKey && usable(item)) return item.id;
		}
		const oldest = list.at(-1);
		if (!oldest) return null;
		if (oldest.createdAt && new Date(oldest.createdAt).getTime() < cutoff) return null;
	}
	return null;
}

/**
 * The only place that talks to `mollie-api-typescript`. Flattens the SDK's
 * request envelopes (`{ idempotencyKey, paymentRequest }`, …), applies a
 * request timeout, and implements the journal's recovery lookups.
 */
export function createGateway(client: Client, config: { timeoutMs?: number | undefined } = {}) {
	const options = { timeoutMs: config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS };
	return {
		createCustomer: (body: EntityCustomer, idempotencyKey: string) =>
			client.customers.create({ idempotencyKey, entityCustomer: body }, options),

		getCustomer: (customerId: string) => client.customers.get({ customerId }, options),

		updateCustomer: (customerId: string, body: { name?: string; email?: string }) =>
			client.customers.update({ customerId, requestBody: body }, options),

		async findCustomerByOperationKey(operationKey: string, since: Date) {
			return scanForOperationKey(
				await client.customers.list({ limit: PAGE_LIMIT, sort: "desc" }, options),
				(page) => page.result.embedded?.customers,
				operationKey,
				since,
			);
		},

		createPayment: (body: PaymentRequest, idempotencyKey: string) =>
			client.payments.create({ idempotencyKey, paymentRequest: body }, options),

		getPayment: (paymentId: string) => client.payments.get({ paymentId }, options),

		async findCustomerPaymentByOperationKey(customerId: string, operationKey: string, since: Date) {
			return scanForOperationKey(
				await client.customers.listPayments(
					{ customerId, limit: PAGE_LIMIT, sort: "desc" },
					options,
				),
				(page) => page.result.embedded?.payments,
				operationKey,
				since,
			);
		},

		createSubscription: (customerId: string, body: SubscriptionRequest, idempotencyKey: string) =>
			client.subscriptions.create(
				{ customerId, idempotencyKey, subscriptionRequest: body },
				options,
			),

		getSubscription: (customerId: string, subscriptionId: string) =>
			client.subscriptions.get({ customerId, subscriptionId }, options),

		cancelSubscription: (customerId: string, subscriptionId: string, idempotencyKey: string) =>
			client.subscriptions.cancel({ customerId, subscriptionId, idempotencyKey }, options),

		async findSubscriptionByOperationKey(customerId: string, operationKey: string, since: Date) {
			// A created subscription that has since ended is not a usable result.
			return scanForOperationKey(
				await client.subscriptions.list({ customerId, limit: PAGE_LIMIT, sort: "desc" }, options),
				(page) => page.result.embedded?.subscriptions,
				operationKey,
				since,
				(item) => {
					const status = (item as { status?: string }).status;
					return status !== "canceled" && status !== "completed";
				},
			);
		},

		async listCustomerSubscriptions(customerId: string): Promise<ListSubscriptionResponse[]> {
			const page = await client.subscriptions.list(
				{ customerId, limit: 50, sort: "desc" },
				options,
			);
			return page.result.embedded?.subscriptions ?? [];
		},

		async listSubscriptionPayments(
			customerId: string,
			subscriptionId: string,
			limit = 10,
		): Promise<ListPaymentResponse[]> {
			const page = await client.subscriptions.listPayments(
				{ customerId, subscriptionId, limit, sort: "desc" },
				options,
			);
			return page.result.embedded?.payments ?? [];
		},

		createSalesInvoice: (
			body: SalesInvoiceRequest,
			idempotencyKey: string,
		): Promise<SalesInvoiceResponse> =>
			client.salesInvoices.create({ idempotencyKey, salesInvoiceRequest: body }, options),

		async findSalesInvoiceByOperationKey(operationKey: string) {
			// Mollie does not document this list's order, so scan it completely.
			return scanForOperationKey(
				await client.salesInvoices.list({ limit: PAGE_LIMIT }, options),
				(page) => page.result.embedded?.invoices as Listed[] | undefined,
				operationKey,
				new Date(0),
			);
		},

		createRefund: (
			paymentId: string,
			body: {
				amount: { currency: string; value: string };
				description: string;
				metadata: Record<string, unknown>;
			},
			idempotencyKey: string,
		) => client.refunds.create({ paymentId, idempotencyKey, refundRequest: body }, options),

		async findRefundByOperationKey(paymentId: string, operationKey: string) {
			return scanForOperationKey(
				await client.refunds.list({ paymentId, limit: PAGE_LIMIT }, options),
				(page) => page.result.embedded?.refunds as Listed[] | undefined,
				operationKey,
				new Date(0),
			);
		},
	};
}

export type MollieGateway = ReturnType<typeof createGateway>;

const gateways = new WeakMap<Client, MollieGateway>();

/** The gateway for the plugin's configured client (one per client). */
export function gatewayFor(options: {
	mollieClient: Client;
	requestTimeoutMs?: number | undefined;
}): MollieGateway {
	let gateway = gateways.get(options.mollieClient);
	if (!gateway) {
		gateway = createGateway(options.mollieClient, { timeoutMs: options.requestTimeoutMs });
		gateways.set(options.mollieClient, gateway);
	}
	return gateway;
}

/** The checkout URL of a payment, if it has one. */
export function checkoutUrl(payment: MolliePayment): string | undefined {
	return payment.links?.checkout?.href ?? undefined;
}
