import type { GenericEndpointContext } from "better-auth";
import type { SalesInvoiceRequest, SalesInvoiceResponse } from "mollie-api-typescript/models";
import { gatewayFor } from "./gateway";
import { OperationInProgressError, runOperation } from "./operations";
import type {
	MollieOperation,
	MollieOptions,
	MolliePaymentRecord,
	PaymentHookData,
	PaymentOutcome,
	Subscription,
} from "./types";
import { addDays, errorMessage, mergeMetadata } from "./utils";

/**
 * The default invoice for a paid payment: one line for the plan, marked as
 * paid by that Mollie payment. With `subscription.tax`, the line is the net
 * amount at the customer's VAT rate; otherwise the charged amount is treated
 * as VAT-inclusive at `salesInvoices.vatRate`.
 */
function defaultInvoiceRequest(
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

const INVOICED_OUTCOMES: readonly PaymentOutcome[] = ["applied", "kept"];

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
	// Not decided yet: the payment may still turn out to be a duplicate.
	if (data.record.outcome === "pending") return null;
	// Never invoiced (recorded, so the catch-up does not look at it again):
	// verification payments (unless asked), duplicates that are (being)
	// refunded, and payments the app chose not to invoice.
	// A verification that `refundVerificationPayment` refunds is not invoiced.
	const refunded =
		options.subscription?.enabled === true && !!options.subscription.refundVerificationPayment;
	const verificationInvoiced = config.invoiceVerificationPayments && !refunded;
	if (
		(data.isVerification && !verificationInvoiced) ||
		!INVOICED_OUTCOMES.includes(data.record.outcome)
	) {
		await markInvoice(ctx, data.payment.id, "skipped");
		return null;
	}
	const recipient = await config.getRecipient(data, ctx);
	if (!recipient) {
		await markInvoice(ctx, data.payment.id, "skipped");
		return null;
	}

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
		recover: (idempotencyKey) => gateway.findSalesInvoiceByOperationKey(idempotencyKey),
	});
	await markInvoice(ctx, data.payment.id, "created");
	if (!operation.result) return null;
	await config.onInvoiceCreated?.({ ...data, invoice: operation.result }, ctx);
	return operation.result;
}

async function markInvoice(
	ctx: GenericEndpointContext,
	molliePaymentId: string,
	invoice: "created" | "skipped",
): Promise<void> {
	await ctx.context.adapter.update({
		model: "molliePayment",
		where: [{ field: "molliePaymentId", value: molliePaymentId }],
		update: { invoice },
	});
}

/** How far back the sync looks for paid payments without an invoice. */
const CATCH_UP_DAYS = 30;
const PAGE_SIZE = 100;
/** Bounds one sync run; the rest is picked up by the next run. */
const MAX_INVOICES_PER_RUN = 100;

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
	onError: (record: MolliePaymentRecord, message: string) => void = () => {},
	/** Only payments of these subscriptions. */
	subscriptionIds?: string[],
): Promise<number> {
	if (!options.salesInvoices?.enabled) return 0;
	const { adapter } = ctx.context;
	const paid: MolliePaymentRecord[] = [];
	// Subscriptions in batches: databases limit the size of an `in` list.
	const batches: (string[] | undefined)[] = subscriptionIds
		? Array.from({ length: Math.ceil(subscriptionIds.length / PAGE_SIZE) }, (_, i) =>
				subscriptionIds.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE),
			)
		: [undefined];
	for (const batch of batches) {
		for (let offset = 0; ; offset += PAGE_SIZE) {
			const page = await adapter.findMany<MolliePaymentRecord>({
				model: "molliePayment",
				where: [
					{ field: "status", value: "paid" },
					{ field: "outcome", operator: "in", value: [...INVOICED_OUTCOMES] },
					// Not invoiced or skipped yet.
					{ field: "invoice", value: null },
					{ field: "paidAt", operator: "gte", value: addDays(now, -CATCH_UP_DAYS) },
					...(batch ? [{ field: "subscriptionId", operator: "in" as const, value: batch }] : []),
				],
				sortBy: { field: "molliePaymentId", direction: "asc" },
				limit: PAGE_SIZE,
				offset,
			});
			paid.push(...page);
			if (page.length < PAGE_SIZE) break;
		}
	}
	let created = 0;
	for (const record of paid) {
		if (created >= MAX_INVOICES_PER_RUN) break;
		const prefix = `sales-invoice:${record.molliePaymentId}#`;
		const done = await adapter.findMany<MollieOperation>({
			model: "mollieOperation",
			where: [
				{ field: "kind", value: "create_sales_invoice" },
				{ field: "idempotencyKey", operator: "starts_with", value: prefix },
			],
			limit: 20,
		});
		if (done.some((op) => op.idempotencyKey.startsWith(prefix) && op.status === "succeeded")) {
			continue;
		}
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
			onError(record, `sales invoice for ${record.molliePaymentId}: ${errorMessage(error)}`);
		}
	}
	return created;
}
