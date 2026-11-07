import type { Client } from "mollie-api-typescript";

/**
 * In-memory stand-in for the parts of `mollie-api-typescript` the plugin uses
 * (customers, payments, subscriptions, sales invoices), with the SDK's request
 * envelopes and response shapes.
 *
 * It keeps state like Mollie does, applies Mollie's idempotency rules (replay
 * on the same key and parameters, 400 on different parameters, 409 while the
 * first request is still processing), and lets tests drive payments to final
 * states, simulate the subscription scheduler and inject failures.
 */

type Amount = { currency: string; value: string };
type Link = { href: string; type: string };

export type FakePayment = {
	resource: "payment";
	id: string;
	mode: "test";
	status: "open" | "pending" | "authorized" | "paid" | "failed" | "canceled" | "expired";
	amount: Amount;
	description: string;
	sequenceType: "oneoff" | "first" | "recurring";
	profileId: string;
	customerId?: string | undefined;
	mandateId?: string | null | undefined;
	subscriptionId?: string | null | undefined;
	method?: string | null;
	metadata: unknown;
	redirectUrl?: string | null | undefined;
	cancelUrl?: string | null | undefined;
	webhookUrl?: string | null | undefined;
	locale?: string | null | undefined;
	createdAt: string;
	paidAt?: string | null | undefined;
	failedAt?: string | null | undefined;
	expiredAt?: string | null | undefined;
	canceledAt?: string | null | undefined;
	/** Charged back and not reversed (absent when nothing is). */
	amountChargedBack?: Amount | undefined;
	/** What can still be refunded, on a paid payment. */
	amountRemaining?: Amount | undefined;
	links: { self: Link; dashboard: Link; checkout?: Link; changePaymentState?: Link | null };
};

export type FakeChargeback = {
	resource: "chargeback";
	id: string;
	amount: Amount;
	paymentId: string;
	createdAt: string;
	reversedAt?: string | null | undefined;
};

export type FakeSubscription = {
	resource: "subscription";
	id: string;
	mode: "test";
	status: "pending" | "active" | "canceled" | "suspended" | "completed";
	amount: Amount;
	times: number | null;
	timesRemaining: number | null;
	interval: string;
	description: string;
	startDate: string;
	nextPaymentDate?: string | null | undefined;
	method: string | null;
	customerId: string;
	mandateId?: string | undefined;
	webhookUrl: string | null;
	metadata: unknown;
	createdAt: string;
	canceledAt?: string | null | undefined;
	links: { self: Link };
};

export type FakeCustomer = {
	resource: "customer";
	id: string;
	mode: "test";
	name: string | null;
	email: string | null;
	locale: string | null;
	metadata: unknown;
	createdAt: string;
	links: { self: Link };
};

export type FakeMandate = {
	resource: "mandate";
	id: string;
	status: "valid" | "pending" | "invalid";
	method: string;
	customerId: string;
	createdAt: string;
};

export type FakeSalesInvoice = {
	resource: "sales-invoice";
	id: string;
	mode: "test";
	status: string;
	invoiceNumber: string | null;
	metadata: unknown;
	request: Record<string, unknown>;
	createdAt: string;
};

export type FakeCall = { method: string; args: unknown[] };

export function mollieError(statusCode: number, message = `Mollie error ${statusCode}`) {
	return Object.assign(new Error(message), { name: "ErrorResponse", statusCode });
}

function addMonths(date: string, months: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	const day = d.getUTCDate();
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() + months);
	const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
	d.setUTCDate(Math.min(day, last));
	return d.toISOString().slice(0, 10);
}

const link = (href: string): Link => ({ href, type: "application/hal+json" });
const page = <K extends string, T>(key: K, items: T[]) => ({
	result: { count: items.length, embedded: { [key]: items } as Record<K, T[]>, links: {} },
});

/**
 * Like the SDK's PageIterator: the first page's fields, plus async
 * iteration over all pages (first page included).
 */
function paginate<K extends string, T>(key: K, items: T[], limit = 50) {
	const size = Math.min(Math.max(limit, 1), 250);
	const pages: ReturnType<typeof page<K, T>>[] = [];
	for (let i = 0; i < items.length; i += size) pages.push(page(key, items.slice(i, i + size)));
	if (pages.length === 0) pages.push(page(key, []));
	return {
		...pages[0]!,
		async *[Symbol.asyncIterator]() {
			for (const p of pages) yield p;
		},
	};
}

export function createFakeMollie(options: { now?: () => Date } = {}) {
	let clock = options.now ?? (() => new Date());
	let counter = 0;
	const id = (prefix: string) => `${prefix}_fake${(++counter).toString().padStart(4, "0")}`;
	const iso = () => clock().toISOString();

	const customers = new Map<string, FakeCustomer>();
	const payments = new Map<string, FakePayment>();
	const subscriptions = new Map<string, FakeSubscription>();
	const mandates = new Map<string, FakeMandate>();
	const salesInvoices = new Map<string, FakeSalesInvoice>();
	const refunds = new Map<
		string,
		{ id: string; paymentId: string; amount: Amount; metadata: unknown; createdAt: string }
	>();
	const chargebacks = new Map<string, FakeChargeback>();
	/** Whether `amountChargedBack` still counts reversed chargebacks (Mollie does not say). */
	let grossChargebacks = false;
	/** What Mollie reports on the payment: charged back (and not reversed, by default). */
	const updateChargedBack = (paymentId: string) => {
		const payment = payments.get(paymentId);
		if (!payment) return;
		const cents = [...chargebacks.values()]
			.filter((c) => c.paymentId === paymentId && (grossChargebacks || !c.reversedAt))
			.reduce((sum, c) => sum + Math.round(Number(c.amount.value) * 100), 0);
		if (cents > 0) {
			payment.amountChargedBack = {
				currency: payment.amount.currency,
				value: (cents / 100).toFixed(2),
			};
		} else delete payment.amountChargedBack;
		updateRemaining(paymentId);
	};
	const toCents = (value: string) => Math.round(Number(value) * 100);
	/** Mollie's `amountRemaining`: the amount less refunds and chargebacks. */
	function remainingCents(paymentId: string): number {
		const payment = payments.get(paymentId);
		if (!payment) return 0;
		const refunded = [...refunds.values()]
			.filter((r) => r.paymentId === paymentId)
			.reduce((sum, r) => sum + toCents(r.amount.value), 0);
		const chargedBack = [...chargebacks.values()]
			.filter((c) => c.paymentId === paymentId && !c.reversedAt)
			.reduce((sum, c) => sum + toCents(c.amount.value), 0);
		return Math.max(0, toCents(payment.amount.value) - refunded - chargedBack);
	}
	function updateRemaining(paymentId: string) {
		const payment = payments.get(paymentId);
		if (payment?.status !== "paid") return;
		payment.amountRemaining = {
			currency: payment.amount.currency,
			value: (remainingCents(paymentId) / 100).toFixed(2),
		};
	}
	/** Mollie's stored responses per idempotency key (kept for one hour in reality). */
	const idempotency = new Map<string, { fingerprint: string; value?: unknown; error?: unknown }>();
	const inFlight = new Set<string>();
	const holds = new Map<string, { phase: "arrival" | "processing"; gate: Promise<void> }>();
	const calls: FakeCall[] = [];
	const failures = new Map<string, unknown[]>();
	/** Called after a create succeeds but before the response returns. */
	const afterCreate = new Map<string, () => void | Promise<void>>();
	/** Methods whose next response (success or error) is lost on the way back. */
	const lostResponses = new Set<string>();
	const loseResponse = (method: string) => {
		if (!lostResponses.delete(method)) return;
		throw new TypeError("socket hang up");
	};

	function record(method: string, args: unknown[]) {
		calls.push({ method, args });
		const queue = failures.get(method);
		if (queue && queue.length > 0) throw queue.shift();
	}

	function stableStringify(value: unknown): string {
		if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
		if (value && typeof value === "object") {
			return `{${Object.keys(value)
				.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`)
				.join(",")}}`;
		}
		return JSON.stringify(value);
	}

	async function takeHold(method: string, phase: "arrival" | "processing") {
		const hold = holds.get(method);
		if (hold && hold.phase === phase) {
			holds.delete(method);
			await hold.gate;
		}
	}

	/**
	 * Mollie idempotency semantics: a known key with the same parameters
	 * replays the stored response (success or error), with different
	 * parameters it is rejected with 400, and while the first request is still
	 * processing a second one gets 409.
	 */
	async function idempotent<T>(method: string, request: any, create: () => T): Promise<T> {
		record(method, [request]);
		await takeHold(method, "arrival");
		const { idempotencyKey: key, ...rest } = request as { idempotencyKey?: string };
		const fingerprint = `${method}:${stableStringify(rest)}`;
		if (key && key.length > 100) {
			// Verified against the real API.
			throw mollieError(
				400,
				`Invalid idempotency key '${key}'. Please provide a unique string of up to 100 characters.`,
			);
		}
		if (key) {
			const stored = idempotency.get(key);
			if (stored) {
				if (stored.fingerprint !== fingerprint) {
					throw mollieError(
						400,
						"The Idempotency-Key has already been used with different request parameters",
					);
				}
				if (stored.error) throw stored.error;
				return structuredClone(stored.value) as T;
			}
			if (inFlight.has(key)) {
				throw mollieError(409, "A request with this Idempotency-Key is still being processed");
			}
			inFlight.add(key);
		}
		try {
			await takeHold(method, "processing");
			const created = create();
			if (key) idempotency.set(key, { fingerprint, value: structuredClone(created) });
			await afterCreate.get(method)?.();
			loseResponse(method);
			return structuredClone(created);
		} catch (error) {
			if (key && !idempotency.has(key)) idempotency.set(key, { fingerprint, error });
			loseResponse(method);
			throw error;
		} finally {
			if (key) inFlight.delete(key);
		}
	}

	function notFound(): never {
		throw mollieError(404, "The resource could not be found");
	}

	const clone = <T>(value: T): T => structuredClone(value);

	function createPayment(body: any): FakePayment {
		const paymentId = id("tr");
		const payment: FakePayment = {
			resource: "payment",
			id: paymentId,
			mode: "test",
			status: "open",
			amount: { ...body.amount },
			description: body.description,
			sequenceType: body.sequenceType ?? "oneoff",
			profileId: "pfl_fake",
			customerId: body.customerId,
			mandateId: body.mandateId ?? null,
			subscriptionId: null,
			method: Array.isArray(body.method) ? null : (body.method ?? null),
			metadata: body.metadata ?? null,
			redirectUrl: body.redirectUrl ?? null,
			cancelUrl: body.cancelUrl ?? null,
			webhookUrl: body.webhookUrl ?? null,
			locale: body.locale ?? null,
			createdAt: iso(),
			links: {
				self: link(`https://api.mollie.com/v2/payments/${paymentId}`),
				dashboard: link(`https://my.mollie.com/dashboard/payments/${paymentId}`),
				...(body.sequenceType === "recurring"
					? { changePaymentState: link(`https://www.mollie.com/checkout/test-mode?t=${paymentId}`) }
					: { checkout: link(`https://www.mollie.com/checkout/test-mode?t=${paymentId}`) }),
			},
		};
		payments.set(paymentId, payment);
		return payment;
	}

	const client = {
		customers: {
			create: (request: any) =>
				idempotent("customers.create", request, () => {
					const body = request.entityCustomer ?? {};
					const customer: FakeCustomer = {
						resource: "customer",
						id: id("cst"),
						mode: "test",
						name: body.name ?? null,
						email: body.email ?? null,
						locale: body.locale ?? null,
						metadata: body.metadata ?? null,
						createdAt: iso(),
						links: { self: link("https://api.mollie.com/v2/customers") },
					};
					customers.set(customer.id, customer);
					return customer;
				}),
			async get(request: { customerId: string }) {
				record("customers.get", [request]);
				return clone(customers.get(request.customerId) ?? notFound());
			},
			async update(request: { customerId: string; requestBody?: any }) {
				record("customers.update", [request]);
				const customer = customers.get(request.customerId) ?? notFound();
				Object.assign(customer, request.requestBody ?? {});
				return clone(customer);
			},
			async list(request: { limit?: number } = {}) {
				record("customers.list", [request]);
				return paginate("customers", [...customers.values()].reverse().map(clone), request.limit);
			},
			async listPayments(request: { customerId: string; limit?: number }) {
				record("customers.listPayments", [request]);
				await takeHold("customers.listPayments", "arrival");
				return paginate(
					"payments",
					[...payments.values()]
						.filter((p) => p.customerId === request.customerId)
						.reverse()
						.map(clone),
					request.limit,
				);
			},
		},
		payments: {
			create: (request: any) =>
				idempotent("payments.create", request, () => createPayment(request.paymentRequest)),
			async get(request: { paymentId: string }) {
				record("payments.get", [request]);
				return clone(payments.get(request.paymentId) ?? notFound());
			},
		},
		mandates: {
			async get(request: { customerId: string; mandateId: string }) {
				record("mandates.get", [request]);
				const mandate = mandates.get(request.mandateId);
				if (!mandate || mandate.customerId !== request.customerId) notFound();
				return clone(mandate);
			},
			async list(request: { customerId: string }) {
				record("mandates.list", [request]);
				return paginate(
					"mandates",
					[...mandates.values()].filter((m) => m.customerId === request.customerId).map(clone),
				);
			},
		},
		subscriptions: {
			create: (request: any) =>
				idempotent("subscriptions.create", request, () => {
					const body = request.subscriptionRequest ?? {};
					const mandate = body.mandateId ? mandates.get(body.mandateId) : undefined;
					if (body.mandateId && (!mandate || mandate.status === "invalid")) {
						throw mollieError(422, "The mandate is invalid");
					}
					const duplicate = [...subscriptions.values()].some(
						(s) =>
							s.customerId === request.customerId &&
							s.status === "active" &&
							s.description === body.description,
					);
					if (duplicate) throw mollieError(422, "The subscription description must be unique");
					const startDate = body.startDate ?? iso().slice(0, 10);
					const subscription: FakeSubscription = {
						resource: "subscription",
						id: id("sub"),
						mode: "test",
						status: "active",
						amount: { ...body.amount },
						times: body.times ?? null,
						timesRemaining: body.times ?? null,
						interval: body.interval,
						description: body.description,
						startDate,
						nextPaymentDate: startDate,
						method: body.method ?? null,
						customerId: request.customerId,
						mandateId: body.mandateId,
						webhookUrl: body.webhookUrl ?? null,
						metadata: body.metadata ?? null,
						createdAt: iso(),
						links: { self: link("https://api.mollie.com/v2/subscriptions") },
					};
					subscriptions.set(subscription.id, subscription);
					return subscription;
				}),
			async get(request: { customerId: string; subscriptionId: string }) {
				record("subscriptions.get", [request]);
				const subscription = subscriptions.get(request.subscriptionId);
				if (!subscription || subscription.customerId !== request.customerId) notFound();
				return clone(subscription);
			},
			cancel: (request: { customerId: string; subscriptionId: string; idempotencyKey?: string }) =>
				idempotent("subscriptions.cancel", request, () => {
					const subscription = subscriptions.get(request.subscriptionId);
					if (!subscription || subscription.customerId !== request.customerId) notFound();
					if (subscription.status === "canceled") {
						throw mollieError(422, "The subscription has been canceled");
					}
					subscription.status = "canceled";
					subscription.canceledAt = iso();
					subscription.nextPaymentDate = null;
					return clone(subscription);
				}),
			async list(request: { customerId: string; limit?: number }) {
				record("subscriptions.list", [request]);
				return paginate(
					"subscriptions",
					[...subscriptions.values()]
						.filter((s) => s.customerId === request.customerId)
						.reverse()
						.map(clone),
					request.limit,
				);
			},
			async listPayments(request: { customerId: string; subscriptionId: string; limit?: number }) {
				record("subscriptions.listPayments", [request]);
				return paginate(
					"payments",
					[...payments.values()]
						.filter((p) => p.subscriptionId === request.subscriptionId)
						.reverse()
						.map(clone),
					request.limit,
				);
			},
		},
		chargebacks: {
			async list(request: { paymentId: string; limit?: number }) {
				record("chargebacks.list", [request]);
				const result = paginate(
					"chargebacks",
					[...chargebacks.values()]
						.filter((c) => c.paymentId === request.paymentId)
						.reverse()
						.map(clone),
					request.limit,
				);
				// The response, as it was, on its way back.
				await takeHold("chargebacks.list", "processing");
				return result;
			},
			async all(request: { limit?: number } = {}) {
				record("chargebacks.all", [request]);
				return paginate(
					"chargebacks",
					[...chargebacks.values()].reverse().map(clone),
					request.limit,
				);
			},
		},
		refunds: {
			create: (request: any) =>
				idempotent("refunds.create", request, () => {
					const payment = payments.get(request.paymentId);
					if (payment?.status !== "paid") throw mollieError(422, "Not refundable");
					if (toCents(request.refundRequest.amount.value) > remainingCents(request.paymentId)) {
						throw mollieError(422, "The amount is higher than what can be refunded");
					}
					const refund = {
						id: id("re"),
						paymentId: request.paymentId,
						amount: { ...request.refundRequest.amount },
						metadata: request.refundRequest.metadata ?? null,
						createdAt: iso(),
					};
					refunds.set(refund.id, refund);
					updateRemaining(request.paymentId);
					return refund;
				}),
			async list(request: { paymentId: string; limit?: number }) {
				record("refunds.list", [request]);
				return paginate(
					"refunds",
					[...refunds.values()].filter((r) => r.paymentId === request.paymentId).reverse(),
					request.limit,
				);
			},
		},
		salesInvoices: {
			create: (request: any) =>
				idempotent("salesInvoices.create", request, () => {
					const body = request.salesInvoiceRequest ?? {};
					const invoice: FakeSalesInvoice = {
						resource: "sales-invoice",
						id: id("invoice"),
						mode: "test",
						status: body.status,
						invoiceNumber: body.status === "draft" ? null : `INV-${counter}`,
						metadata: body.metadata ?? null,
						request: clone(body),
						createdAt: iso(),
					};
					salesInvoices.set(invoice.id, invoice);
					return invoice;
				}),
			async list(request: { limit?: number } = {}) {
				record("salesInvoices.list", [request]);
				return paginate(
					"invoices",
					[...salesInvoices.values()].reverse().map(clone),
					request.limit,
				);
			},
		},
	};

	const controls = {
		client: client as unknown as Client,
		calls,
		customers,
		payments,
		subscriptions,
		mandates,
		salesInvoices,
		refunds,
		setNow(now: () => Date) {
			clock = now;
		},
		callsTo(method: string) {
			return calls.filter((c) => c.method === method);
		},
		/** Queue an error for the next call to `method` (thrown before Mollie sees it). */
		failNext(method: string, error: unknown) {
			const queue = failures.get(method) ?? [];
			queue.push(error);
			failures.set(method, queue);
		},
		/**
		 * Run `fn` after the next successful create of `method` (Mollie has
		 * stored the result), before the response returns: throw to lose the
		 * response, or await something to pause the caller.
		 */
		afterNextCreate(method: string, fn: () => void | Promise<void>) {
			afterCreate.set(method, () => {
				afterCreate.delete(method);
				return fn();
			});
		},
		/**
		 * Mollie fully handles the next call to `method` (storing its success or
		 * error under the idempotency key), but the response never arrives.
		 */
		loseNextResponse(method: string) {
			lostResponses.add(method);
		},
		/** Mollie forgets idempotency keys after an hour. */
		expireIdempotencyKeys() {
			idempotency.clear();
		},
		/**
		 * Delay the next call to `method`: `"arrival"` holds it before Mollie
		 * sees it (network delay), `"processing"` while Mollie is working on it
		 * (a concurrent request with the same key gets 409). Returns `release`.
		 */
		hold(method: string, phase: "arrival" | "processing") {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			holds.set(method, { phase, gate });
			return release;
		},
		/**
		 * Simulates the customer finishing (or abandoning) checkout. A paid
		 * first payment creates a valid mandate, like Mollie does.
		 */
		completePayment(paymentId: string, status: FakePayment["status"]) {
			const payment = payments.get(paymentId);
			if (!payment) throw new Error(`Unknown payment ${paymentId}`);
			payment.status = status;
			if (status === "paid") {
				payment.paidAt = iso();
				delete payment.links.checkout;
				updateRemaining(paymentId);
				if (payment.sequenceType === "first" && payment.customerId && !payment.mandateId) {
					const mandate: FakeMandate = {
						resource: "mandate",
						id: id("mdt"),
						status: "valid",
						method: "creditcard",
						customerId: payment.customerId,
						createdAt: iso(),
					};
					mandates.set(mandate.id, mandate);
					payment.mandateId = mandate.id;
				}
			}
			if (status === "failed") payment.failedAt = iso();
			if (status === "expired") payment.expiredAt = iso();
			if (status === "canceled") payment.canceledAt = iso();
			return clone(payment);
		},
		/** A chargeback of (part of) a paid payment, as a bank or card scheme reports it. */
		chargeBack(paymentId: string, value?: string) {
			const payment = payments.get(paymentId);
			if (payment?.status !== "paid") throw new Error(`Payment ${paymentId} is not paid`);
			const chargeback: FakeChargeback = {
				resource: "chargeback",
				id: id("chb"),
				amount: { currency: payment.amount.currency, value: value ?? payment.amount.value },
				paymentId,
				createdAt: iso(),
				reversedAt: null,
			};
			chargebacks.set(chargeback.id, chargeback);
			updateChargedBack(paymentId);
			return clone(chargeback);
		},
		reportReversedChargebacks() {
			grossChargebacks = true;
		},
		reverseChargeback(chargebackId: string) {
			const chargeback = chargebacks.get(chargebackId);
			if (!chargeback) throw new Error(`Unknown chargeback ${chargebackId}`);
			chargeback.reversedAt = iso();
			updateChargedBack(chargeback.paymentId);
		},
		/**
		 * Simulates Mollie's scheduler charging a subscription: creates a
		 * recurring payment carrying `subscriptionId` and the subscription's
		 * metadata, and moves `nextPaymentDate` one interval forward.
		 */
		chargeSubscription(subscriptionId: string, status: FakePayment["status"] = "open") {
			const subscription = subscriptions.get(subscriptionId);
			if (!subscription) throw new Error(`Unknown subscription ${subscriptionId}`);
			const payment = createPayment({
				amount: subscription.amount,
				description: subscription.description,
				sequenceType: "recurring",
				customerId: subscription.customerId,
				mandateId: subscription.mandateId,
				metadata: subscription.metadata,
				webhookUrl: subscription.webhookUrl,
			});
			payment.subscriptionId = subscription.id;
			const months = Number(/^(\d+) month/.exec(subscription.interval)?.[1] ?? 1);
			subscription.nextPaymentDate = addMonths(
				subscription.nextPaymentDate ?? subscription.startDate,
				months,
			);
			if (status !== "open") controls.completePayment(payment.id, status);
			return clone(payment);
		},
		setSubscriptionStatus(subscriptionId: string, status: FakeSubscription["status"]) {
			const subscription = subscriptions.get(subscriptionId);
			if (!subscription) throw new Error(`Unknown subscription ${subscriptionId}`);
			subscription.status = status;
			if (status === "canceled" || status === "completed") subscription.nextPaymentDate = null;
		},
		activeSubscriptionsFor(customerId: string) {
			return [...subscriptions.values()].filter(
				(s) => s.customerId === customerId && s.status === "active",
			);
		},
	};
	return controls;
}

export type FakeMollie = ReturnType<typeof createFakeMollie>;
