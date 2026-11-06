import type { MollieClient } from "@mollie/api-client";

/**
 * In-memory stand-in for the parts of `@mollie/api-client` the plugin uses.
 *
 * It keeps state like Mollie does (customers, payments, mandates,
 * subscriptions), replays requests that reuse an idempotency key, and lets
 * tests drive payments to final states and inject failures.
 */

type Amount = { currency: string; value: string };
type Links = Record<string, { href: string; type: string } | undefined>;

export type FakePayment = {
	resource: "payment";
	id: string;
	mode: "test";
	status: "open" | "pending" | "authorized" | "paid" | "failed" | "canceled" | "expired";
	amount: Amount;
	description: string;
	sequenceType: "oneoff" | "first" | "recurring";
	customerId?: string | undefined;
	mandateId?: string | undefined;
	subscriptionId?: string | undefined;
	method?: string | null;
	metadata: unknown;
	redirectUrl?: string | undefined;
	cancelUrl?: string | undefined;
	webhookUrl?: string | undefined;
	locale?: string | undefined;
	createdAt: string;
	paidAt?: string | undefined;
	failedAt?: string | undefined;
	expiredAt?: string | undefined;
	canceledAt?: string | undefined;
	_links: Links;
};

export type FakeSubscription = {
	resource: "subscription";
	id: string;
	mode: "test";
	status: "pending" | "active" | "canceled" | "suspended" | "completed";
	amount: Amount;
	interval: string;
	description: string;
	startDate: string;
	nextPaymentDate?: string | undefined;
	customerId: string;
	mandateId?: string | undefined;
	webhookUrl?: string | undefined;
	metadata: unknown;
	createdAt: string;
	canceledAt?: string | undefined;
};

export type FakeCustomer = {
	resource: "customer";
	id: string;
	name?: string | undefined;
	email?: string | undefined;
	metadata: unknown;
	createdAt: string;
};

export type FakeMandate = {
	resource: "mandate";
	id: string;
	status: "valid" | "pending" | "invalid";
	method: string;
	customerId: string;
	createdAt: string;
};

export type FakeCall = { method: string; args: unknown[] };

export function mollieError(statusCode: number, message = `Mollie error ${statusCode}`) {
	return Object.assign(new Error(message), { name: "ApiError", statusCode });
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

export function createFakeMollie(options: { now?: () => Date } = {}) {
	let clock = options.now ?? (() => new Date());
	let counter = 0;
	const id = (prefix: string) => `${prefix}_fake${(++counter).toString().padStart(4, "0")}`;
	const iso = () => clock().toISOString();

	const customers = new Map<string, FakeCustomer>();
	const payments = new Map<string, FakePayment>();
	const subscriptions = new Map<string, FakeSubscription>();
	const mandates = new Map<string, FakeMandate>();
	/** Mollie's stored responses per idempotency key (kept for one hour in reality). */
	const idempotency = new Map<string, { fingerprint: string; value?: unknown; error?: unknown }>();
	const inFlight = new Set<string>();
	const holds = new Map<string, { phase: "arrival" | "processing"; gate: Promise<void> }>();
	const calls: FakeCall[] = [];
	const failures = new Map<string, unknown[]>();
	/** Called after a create succeeds but before the response returns. */
	const afterCreate = new Map<string, () => void>();

	function record(method: string, args: unknown[]) {
		calls.push({ method, args });
		const queue = failures.get(method);
		if (queue && queue.length > 0) {
			const error = queue.shift();
			throw error;
		}
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
	async function idempotent<T>(method: string, params: any, create: () => T): Promise<T> {
		await takeHold(method, "arrival");
		const key: string | undefined = params.idempotencyKey;
		const { idempotencyKey: _ignored, ...rest } = params;
		const fingerprint = `${method}:${stableStringify(rest)}`;
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
			return created;
		} catch (error) {
			if (key) idempotency.set(key, { fingerprint, error });
			throw error;
		} finally {
			if (key) inFlight.delete(key);
		}
	}

	function notFound(): never {
		throw mollieError(404, "The resource could not be found");
	}

	function clone<T>(value: T): T {
		return structuredClone(value);
	}

	function createPayment(params: any): FakePayment {
		const paymentId = id("tr");
		const payment: FakePayment = {
			resource: "payment",
			id: paymentId,
			mode: "test",
			status: "open",
			amount: { ...params.amount },
			description: params.description,
			sequenceType: params.sequenceType ?? "oneoff",
			customerId: params.customerId,
			mandateId: params.mandateId,
			method: Array.isArray(params.method) ? null : (params.method ?? null),
			metadata: params.metadata ?? null,
			redirectUrl: params.redirectUrl,
			cancelUrl: params.cancelUrl,
			webhookUrl: params.webhookUrl,
			locale: params.locale,
			createdAt: iso(),
			_links: {
				checkout:
					params.sequenceType === "recurring"
						? undefined
						: {
								href: `https://www.mollie.com/checkout/test-mode?token=${paymentId}`,
								type: "text/html",
							},
			},
		};
		payments.set(paymentId, payment);
		return payment;
	}

	const client = {
		customers: {
			async create(params: any) {
				record("customers.create", [params]);
				const result = await idempotent("customers.create", params, () => {
					const customer: FakeCustomer = {
						resource: "customer",
						id: id("cst"),
						name: params.name,
						email: params.email,
						metadata: params.metadata ?? null,
						createdAt: iso(),
					};
					customers.set(customer.id, customer);
					return customer;
				});
				afterCreate.get("customers.create")?.();
				return clone(result);
			},
			async get(customerId: string) {
				record("customers.get", [customerId]);
				return clone(customers.get(customerId) ?? notFound());
			},
			async update(customerId: string, params: any) {
				record("customers.update", [customerId, params]);
				const customer = customers.get(customerId) ?? notFound();
				Object.assign(customer, params);
				return clone(customer);
			},
			async page(params: any = {}) {
				record("customers.page", [params]);
				return [...customers.values()]
					.reverse()
					.slice(0, params.limit ?? 50)
					.map(clone);
			},
		},
		payments: {
			async create(params: any) {
				record("payments.create", [params]);
				const result = await idempotent("payments.create", params, () => createPayment(params));
				afterCreate.get("payments.create")?.();
				return clone(result);
			},
			async get(paymentId: string) {
				record("payments.get", [paymentId]);
				return clone(payments.get(paymentId) ?? notFound());
			},
		},
		customerPayments: {
			async page(params: any) {
				record("customerPayments.page", [params]);
				return [...payments.values()]
					.filter((p) => p.customerId === params.customerId)
					.reverse()
					.slice(0, params.limit ?? 50)
					.map(clone);
			},
		},
		customerMandates: {
			async page(params: any) {
				record("customerMandates.page", [params]);
				return [...mandates.values()]
					.filter((m) => m.customerId === params.customerId)
					.reverse()
					.map(clone);
			},
			async get(mandateId: string, params: any) {
				record("customerMandates.get", [mandateId, params]);
				const mandate = mandates.get(mandateId);
				if (!mandate || mandate.customerId !== params.customerId) notFound();
				return clone(mandate);
			},
		},
		customerSubscriptions: {
			async create(params: any) {
				record("customerSubscriptions.create", [params]);
				const result = await idempotent("customerSubscriptions.create", params, () => {
					const mandate = params.mandateId ? mandates.get(params.mandateId) : undefined;
					if (params.mandateId && (!mandate || mandate.status === "invalid")) {
						throw mollieError(422, "The mandate is invalid");
					}
					const description = params.description as string;
					const duplicate = [...subscriptions.values()].some(
						(s) =>
							s.customerId === params.customerId &&
							s.status === "active" &&
							s.description === description,
					);
					if (duplicate) throw mollieError(422, "Description must be unique");
					const startDate = params.startDate ?? iso().slice(0, 10);
					const subscription: FakeSubscription = {
						resource: "subscription",
						id: id("sub"),
						mode: "test",
						status: "active",
						amount: { ...params.amount },
						interval: params.interval,
						description,
						startDate,
						nextPaymentDate: startDate,
						customerId: params.customerId,
						mandateId: params.mandateId,
						webhookUrl: params.webhookUrl,
						metadata: params.metadata ?? null,
						createdAt: iso(),
					};
					subscriptions.set(subscription.id, subscription);
					return subscription;
				});
				afterCreate.get("customerSubscriptions.create")?.();
				return clone(result);
			},
			async get(subscriptionId: string, params: any) {
				record("customerSubscriptions.get", [subscriptionId, params]);
				const subscription = subscriptions.get(subscriptionId);
				if (!subscription || subscription.customerId !== params.customerId) notFound();
				return clone(subscription);
			},
			async cancel(subscriptionId: string, params: any) {
				record("customerSubscriptions.cancel", [subscriptionId, params]);
				const subscription = subscriptions.get(subscriptionId);
				if (!subscription || subscription.customerId !== params.customerId) notFound();
				if (subscription.status === "canceled") {
					throw mollieError(422, "The subscription has been canceled");
				}
				subscription.status = "canceled";
				subscription.canceledAt = iso();
				subscription.nextPaymentDate = undefined;
				return clone(subscription);
			},
			async page(params: any) {
				record("customerSubscriptions.page", [params]);
				return [...subscriptions.values()]
					.filter((s) => s.customerId === params.customerId)
					.reverse()
					.map(clone);
			},
		},
		subscriptionPayments: {
			async page(params: any) {
				record("subscriptionPayments.page", [params]);
				return [...payments.values()]
					.filter((p) => p.subscriptionId === params.subscriptionId)
					.reverse()
					.slice(0, params.limit ?? 50)
					.map(clone);
			},
		},
	};

	const controls = {
		client: client as unknown as MollieClient,
		calls,
		customers,
		payments,
		subscriptions,
		mandates,
		setNow(now: () => Date) {
			clock = now;
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
		callsTo(method: string) {
			return calls.filter((c) => c.method === method);
		},
		/** Queue an error for the next call to `method`. */
		failNext(method: string, error: unknown) {
			const queue = failures.get(method) ?? [];
			queue.push(error);
			failures.set(method, queue);
		},
		/** Run `fn` after the next successful create of `method` (e.g. to simulate a crash). */
		afterNextCreate(method: string, fn: () => void) {
			afterCreate.set(method, () => {
				afterCreate.delete(method);
				fn();
			});
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
				payment._links.checkout = undefined;
				if (payment.sequenceType === "first" && payment.customerId && !payment.mandateId) {
					const mandate: FakeMandate = {
						resource: "mandate",
						id: id("mdt"),
						status: "valid",
						method: "directdebit",
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
			if (status === "canceled" || status === "completed") subscription.nextPaymentDate = undefined;
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
