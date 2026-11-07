import type { GenericEndpointContext } from "better-auth";
import type { SalesInvoiceRequest, SalesInvoiceResponse } from "mollie-api-typescript/models";
import { gatewayFor } from "./gateway";
import { OperationInProgressError, runOperation } from "./operations";
import type {
	MollieOperation,
	MollieOptions,
	MolliePaymentRecord,
	PaymentHookData,
	Subscription,
} from "./types";
import { addDays, errorMessage, mergeMetadata } from "./utils";

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
		vatMode: tax && !tax.inclusive ? "exclusive" : "inclusive",
		paymentDetails: { source: "payment", sourceReference: payment.id },
		lines: [
			{
				description,
				quantity: 1,
				vatRate: tax ? tax.rate : (config?.vatRate ?? "0.00"),
				// Inclusive prices are invoiced as charged, so the invoice total
				// always equals the payment, whatever rounding Mollie applies.
				unitPrice: {
					currency: payment.amount.currency,
					value: tax && !tax.inclusive ? tax.net : payment.amount.value,
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
		recover: (idempotencyKey, attempt) =>
			gateway.findSalesInvoiceByOperationKey(idempotencyKey, attempt.createdAt),
	});
	if (!operation.result) return null;
	await config.onInvoiceCreated?.({ ...data, invoice: operation.result }, ctx);
	return operation.result;
}

/** How far back the sync looks for paid payments without an invoice. */
const CATCH_UP_DAYS = 30;

/**
 * Creates the sales invoices that were missed, e.g. because the invoice API
 * failed or the process stopped after the payment was recorded. Looks at
 * payments paid in the last 30 days; the per-payment journal makes this safe
 * to run alongside the webhook. Returns the number of invoices created.
 */
export async function catchUpSalesInvoices(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	now: Date,
	hookData: (
		record: MolliePaymentRecord,
		subscription: Subscription,
	) => Promise<PaymentHookData | null>,
): Promise<number> {
	if (!options.salesInvoices?.enabled) return 0;
	const { adapter } = ctx.context;
	const paid = await adapter.findMany<MolliePaymentRecord>({
		model: "molliePayment",
		where: [
			{ field: "status", value: "paid" },
			{ field: "paidAt", operator: "gte", value: addDays(now, -CATCH_UP_DAYS) },
		],
		sortBy: { field: "paidAt", direction: "desc" },
		limit: 200,
	});
	let created = 0;
	for (const record of paid) {
		const prefix = `sales-invoice:${record.molliePaymentId}#`;
		const done = await adapter.findMany<MollieOperation>({
			model: "mollieOperation",
			where: [
				{ field: "kind", value: "create_sales_invoice" },
				{ field: "idempotencyKey", operator: "starts_with", value: prefix },
				{ field: "status", value: "succeeded" },
			],
			limit: 1,
		});
		if (done.some((op) => op.idempotencyKey.startsWith(prefix))) continue;
		const subscription = await adapter.findOne<Subscription>({
			model: "subscription",
			where: [{ field: "id", value: record.subscriptionId }],
		});
		if (!subscription) continue;
		try {
			const data = await hookData(record, subscription);
			if (data && (await createSalesInvoice(ctx, options, data))) created++;
		} catch (error) {
			if (error instanceof OperationInProgressError) continue;
			ctx.context.logger.error(
				`[mollie] Sales invoice for ${record.molliePaymentId} failed: ${errorMessage(error)}`,
			);
		}
	}
	return created;
}
