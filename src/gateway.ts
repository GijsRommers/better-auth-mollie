import type { Client } from "mollie-api-typescript";
import type {
	CustomerResponse,
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

const PAGE_LIMIT = 50;

/**
 * The only place that talks to `mollie-api-typescript`. Flattens the SDK's
 * request envelopes (`{ idempotencyKey, paymentRequest }`, …) and returns the
 * first page of list endpoints, which is all the plugin needs: lookups are for
 * recently created resources.
 */
export function createGateway(client: Client) {
	return {
		createCustomer: (body: EntityCustomer, idempotencyKey: string) =>
			client.customers.create({ idempotencyKey, entityCustomer: body }),

		getCustomer: (customerId: string) => client.customers.get({ customerId }),

		updateCustomer: (customerId: string, body: { name?: string; email?: string }) =>
			client.customers.update({ customerId, requestBody: body }),

		async listCustomers(limit = 250): Promise<CustomerResponse[]> {
			const page = await client.customers.list({ limit });
			return (page.result.embedded?.customers ?? []) as CustomerResponse[];
		},

		createPayment: (body: PaymentRequest, idempotencyKey: string) =>
			client.payments.create({ idempotencyKey, paymentRequest: body }),

		getPayment: (paymentId: string) => client.payments.get({ paymentId }),

		async listCustomerPayments(customerId: string): Promise<ListPaymentResponse[]> {
			const page = await client.customers.listPayments({ customerId, limit: PAGE_LIMIT });
			return page.result.embedded?.payments ?? [];
		},

		createSubscription: (customerId: string, body: SubscriptionRequest, idempotencyKey: string) =>
			client.subscriptions.create({ customerId, idempotencyKey, subscriptionRequest: body }),

		getSubscription: (customerId: string, subscriptionId: string) =>
			client.subscriptions.get({ customerId, subscriptionId }),

		cancelSubscription: (customerId: string, subscriptionId: string, idempotencyKey: string) =>
			client.subscriptions.cancel({ customerId, subscriptionId, idempotencyKey }),

		async listSubscriptions(customerId: string): Promise<ListSubscriptionResponse[]> {
			const page = await client.subscriptions.list({ customerId, limit: PAGE_LIMIT });
			return page.result.embedded?.subscriptions ?? [];
		},

		async listSubscriptionPayments(
			customerId: string,
			subscriptionId: string,
			limit = 10,
		): Promise<ListPaymentResponse[]> {
			const page = await client.subscriptions.listPayments({ customerId, subscriptionId, limit });
			return page.result.embedded?.payments ?? [];
		},

		createSalesInvoice: (
			body: SalesInvoiceRequest,
			idempotencyKey: string,
		): Promise<SalesInvoiceResponse> =>
			client.salesInvoices.create({ idempotencyKey, salesInvoiceRequest: body }),

		async listSalesInvoices(): Promise<{ id: string; metadata?: unknown }[]> {
			const page = await client.salesInvoices.list({ limit: PAGE_LIMIT });
			return (page.result.embedded?.invoices ?? []) as { id: string; metadata?: unknown }[];
		},
	};
}

export type MollieGateway = ReturnType<typeof createGateway>;

const gateways = new WeakMap<Client, MollieGateway>();

/** The gateway for the plugin's configured client (one per client). */
export function gatewayFor(options: { mollieClient: Client }): MollieGateway {
	let gateway = gateways.get(options.mollieClient);
	if (!gateway) {
		gateway = createGateway(options.mollieClient);
		gateways.set(options.mollieClient, gateway);
	}
	return gateway;
}

/** The checkout URL of a payment, if it has one. */
export function checkoutUrl(payment: MolliePayment): string | undefined {
	return payment.links?.checkout?.href ?? undefined;
}

/** Payment metadata as a plain object (Mollie allows strings and arrays too). */
export function metadataOf(resource: { metadata?: unknown }): Record<string, unknown> {
	const metadata = resource.metadata;
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: {};
}
