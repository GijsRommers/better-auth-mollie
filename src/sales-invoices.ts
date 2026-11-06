import type { GenericEndpointContext } from "better-auth";
import type { SalesInvoiceRequest, SalesInvoiceResponse } from "mollie-api-typescript/models";
import { gatewayFor } from "./gateway";
import { findByOperationKey, runOperation } from "./operations";
import type { MollieOptions, PaymentHookData } from "./types";
import { mergeMetadata } from "./utils";

/**
 * The default invoice for a paid payment: one line for the plan, marked as
 * paid by that Mollie payment. With `subscription.tax`, the line is the net
 * amount at the customer's VAT rate; otherwise the charged amount is treated
 * as VAT-inclusive at `salesInvoices.vatRate`.
 */
export function defaultInvoiceRequest(
	options: MollieOptions,
	data: PaymentHookData,
): Omit<SalesInvoiceRequest, "recipient"> {
	const { payment, subscription, plan, tax } = data;
	const config = options.salesInvoices;
	const description = (plan?.description ?? payment.description ?? subscription.plan).slice(0, 100);
	return {
		status: "paid",
		recipientIdentifier: subscription.referenceId,
		vatMode: tax ? "exclusive" : "inclusive",
		paymentDetails: { source: "payment", sourceReference: payment.id },
		lines: [
			{
				description,
				quantity: 1,
				vatRate: tax ? tax.rate : (config?.vatRate ?? "0.00"),
				unitPrice: {
					currency: payment.amount.currency,
					value: tax ? tax.net : payment.amount.value,
				},
			},
		],
		...(config?.eInvoice ? { isEInvoice: true } : {}),
		...(tax?.reverseCharge ? { memo: "VAT reverse charged" } : {}),
	};
}

/**
 * Creates a Mollie sales invoice with status `paid` for a paid payment.
 * Journaled per payment (`sales-invoice:<paymentId>`), so a payment is
 * invoiced at most once even if this runs again.
 */
export async function createSalesInvoice(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	data: PaymentHookData,
): Promise<SalesInvoiceResponse | null> {
	const config = options.salesInvoices;
	if (!config?.enabled) return null;
	if (data.isVerification && !config.invoiceVerificationPayments) return null;
	const recipient = await config.getRecipient(data, ctx);
	if (!recipient) return null;

	let request: SalesInvoiceRequest = { ...defaultInvoiceRequest(options, data), recipient };
	if (config.getInvoiceParams) request = await config.getInvoiceParams(data, request, ctx);

	const gateway = gatewayFor(options);
	const operation = await runOperation(ctx.context, {
		kind: "create_sales_invoice",
		referenceId: data.subscription.referenceId,
		scope: `sales-invoice:${data.payment.id}`,
		reuseSucceeded: true,
		execute: (idempotencyKey) =>
			gateway.createSalesInvoice(
				{
					...request,
					metadata: mergeMetadata(
						{
							molliePaymentId: data.payment.id,
							subscriptionId: data.subscription.id,
							operationKey: idempotencyKey,
						},
						request.metadata,
					),
				},
				idempotencyKey,
			),
		getId: (invoice) => invoice.id,
		recover: async (idempotencyKey) =>
			findByOperationKey(await gateway.listSalesInvoices(), idempotencyKey),
	});
	if (!operation.result) return null;
	await config.onInvoiceCreated?.({ ...data, invoice: operation.result }, ctx);
	return operation.result;
}
