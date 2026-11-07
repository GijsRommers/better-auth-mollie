import type { GenericEndpointContext } from "better-auth";
import type { MolliePayment } from "./gateway";
import { createSalesInvoice } from "./sales-invoices";
import type {
	ChargebackHookData,
	MollieOptions,
	MolliePlan,
	PaymentHookData,
	Subscription,
} from "./types";
import { errorMessage } from "./utils";

export type BillingEvent =
	| {
			type: "subscription.activated";
			subscription: Subscription;
			plan: MolliePlan | undefined;
			payment: MolliePayment;
	  }
	| { type: "payment.paid"; data: PaymentHookData }
	| { type: "payment.failed"; data: PaymentHookData }
	| { type: "payment.duplicate"; data: PaymentHookData; refunded: boolean }
	| { type: "payment.chargeback"; data: ChargebackHookData }
	| {
			type: "subscription.canceled";
			subscription: Subscription;
			plan: MolliePlan | undefined;
			reason: "period_ended" | "mollie_canceled";
	  };

type Task = { name: string; run: () => Promise<unknown> };

/** The independent pieces of work an event triggers. */
function tasksFor(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	event: BillingEvent,
): Task[] {
	const hooks = options.subscription?.enabled ? options.subscription : undefined;
	const tasks: Task[] = [];
	const hook = (name: string, fn: (() => Promise<void>) | undefined) => {
		if (fn) tasks.push({ name, run: fn });
	};
	switch (event.type) {
		case "subscription.activated": {
			const fn = hooks?.onSubscriptionActivated;
			hook(
				"onSubscriptionActivated",
				fn &&
					(() =>
						fn(
							{ subscription: event.subscription, plan: event.plan, payment: event.payment },
							ctx,
						)),
			);
			break;
		}
		case "payment.paid": {
			const fn = hooks?.onPaymentPaid;
			hook("onPaymentPaid", fn && (() => fn(event.data, ctx)));
			if (options.salesInvoices?.enabled) {
				tasks.push({
					name: "salesInvoices",
					run: () => createSalesInvoice(ctx, options, event.data),
				});
			}
			break;
		}
		case "payment.failed": {
			const fn = hooks?.onPaymentFailed;
			hook("onPaymentFailed", fn && (() => fn(event.data, ctx)));
			break;
		}
		case "payment.duplicate": {
			const fn = hooks?.onDuplicatePayment;
			hook(
				"onDuplicatePayment",
				fn && (() => fn({ ...event.data, refunded: event.refunded }, ctx)),
			);
			break;
		}
		case "payment.chargeback": {
			const fn = hooks?.onChargeback;
			hook("onChargeback", fn && (() => fn(event.data, ctx)));
			break;
		}
		case "subscription.canceled": {
			const fn = hooks?.onSubscriptionCanceled;
			hook(
				"onSubscriptionCanceled",
				fn &&
					(() =>
						fn({ subscription: event.subscription, plan: event.plan, reason: event.reason }, ctx)),
			);
			break;
		}
	}
	return tasks;
}

/**
 * Runs the app's hooks after the state change is committed, without holding
 * up the response: Mollie gives webhooks 15 seconds. Uses Better Auth's
 * `advanced.backgroundTasks.handler` (e.g. `waitUntil`) when configured.
 *
 * Hooks are delivered at most once; a failing hook is logged, not retried,
 * and does not stop the other hooks or the sales invoice.
 */
export function dispatchEvents(
	ctx: GenericEndpointContext,
	options: MollieOptions,
	events: BillingEvent[],
): void {
	if (events.length === 0) return;
	const run = async () => {
		for (const event of events) {
			for (const task of tasksFor(ctx, options, event)) {
				try {
					await task.run();
				} catch (error) {
					ctx.context.logger.error(
						`[mollie] ${task.name} failed for ${event.type}: ${errorMessage(error)}`,
					);
				}
			}
		}
	};
	ctx.context.runInBackground(run());
}
