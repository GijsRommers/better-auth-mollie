import type {
	Customer,
	CustomerCreateParams,
	MollieClient,
	Payment,
	PaymentCreateParams,
} from "@mollie/api-client";
import type { GenericEndpointContext, InferOptionSchema, Session, User } from "better-auth";
import type { Organization } from "better-auth/plugins/organization";
import type { getSchemaDefinition } from "./schema";

/**
 * Lifecycle of a subscription.
 *
 * `incomplete → trialing → active → past_due → unpaid | canceled`, plus
 * `incomplete_expired` when the mandate (first) payment never succeeds.
 */
export type SubscriptionStatus =
	| "incomplete"
	| "incomplete_expired"
	| "trialing"
	| "active"
	| "past_due"
	| "unpaid"
	| "canceled";

/** Mollie payment statuses as returned by the Payments API. */
export type MolliePaymentStatus =
	| "open"
	| "pending"
	| "authorized"
	| "paid"
	| "failed"
	| "canceled"
	| "expired";

export type CustomerType = "user" | "organization";

export type AuthorizeReferenceAction =
	| "upgrade-subscription"
	| "list-subscription"
	| "cancel-subscription"
	| "restore-subscription";

type IntervalUnit = "day" | "days" | "week" | "weeks" | "month" | "months";

/**
 * Mollie subscription interval, e.g. `"1 month"` or `"12 months"`.
 * Mollie allows at most 12 months, 52 weeks or 365 days.
 */
export type MollieInterval = "1 month" | "12 months" | `${number} ${IntervalUnit}`;

export type MolliePlan = {
	/**
	 * Plan name. Stored lower-cased on the subscription.
	 */
	name: string;
	/**
	 * Amount charged every interval, as a decimal string with two decimals,
	 * e.g. `"9.95"`. This is the amount Mollie charges, so include VAT if your
	 * prices are VAT-inclusive.
	 */
	amount: string;
	/**
	 * ISO 4217 currency code.
	 * @default "EUR"
	 */
	currency?: string | undefined;
	/**
	 * Billing interval passed to the Mollie Subscriptions API.
	 */
	interval: MollieInterval;
	/**
	 * Shown on the customer's bank statement and in the Mollie dashboard.
	 * A short unique suffix is appended because Mollie requires subscription
	 * descriptions to be unique per customer.
	 * @default `${name} subscription`
	 */
	description?: string | undefined;
	/**
	 * Plan-specific limits, returned by `subscription.list`.
	 */
	limits?: Record<string, unknown> | undefined;
	/**
	 * Free trial. The first payment becomes a small verification payment
	 * (`verificationAmount`) that only creates the mandate, and the Mollie
	 * subscription starts when the trial ends.
	 */
	freeTrial?:
		| {
				days: number;
		  }
		| undefined;
};

export interface Subscription {
	id: string;
	/** User id or organization id that owns this subscription. */
	referenceId: string;
	/** Lower-cased plan name. */
	plan: string;
	status: SubscriptionStatus;
	mollieCustomerId?: string | null | undefined;
	mollieMandateId?: string | null | undefined;
	mollieSubscriptionId?: string | null | undefined;
	periodStart?: Date | null | undefined;
	periodEnd?: Date | null | undefined;
	trialEnd?: Date | null | undefined;
	/**
	 * The Mollie subscription has been canceled and the subscription ends at
	 * `periodEnd`. `subscription.restore` undoes this before `periodEnd`.
	 */
	cancelAtPeriodEnd?: boolean | null | undefined;
	createdAt: Date;
	updatedAt: Date;
}

export interface MolliePaymentRecord {
	id: string;
	molliePaymentId: string;
	/** Local subscription id. */
	subscriptionId: string;
	amount: string;
	currency: string;
	status: MolliePaymentStatus;
	sequenceType: "oneoff" | "first" | "recurring";
	paidAt?: Date | null | undefined;
	failedAt?: Date | null | undefined;
}

export type MollieOperationStatus = "pending" | "succeeded" | "failed";

export type MollieOperationKind =
	| "create_customer"
	| "create_first_payment"
	| "create_subscription"
	| "cancel_subscription"
	| "create_sales_invoice";

/**
 * Write-ahead journal entry. Written before every mutating Mollie call so a
 * lost response (crash, timeout) can be recovered instead of repeated.
 */
export interface MollieOperation {
	id: string;
	idempotencyKey: string;
	kind: MollieOperationKind;
	referenceId: string;
	status: MollieOperationStatus;
	mollieId?: string | null | undefined;
	createdAt: Date;
}

export type WithMollieCustomerId = {
	mollieCustomerId?: string | null | undefined;
};

export type WithActiveOrganizationId = {
	activeOrganizationId?: string | null | undefined;
};

export type MollieCtxSession = {
	session: Session & WithActiveOrganizationId;
	user: User & WithMollieCustomerId;
};

export type PaymentHookData = {
	/** The payment exactly as fetched from the Mollie API. */
	payment: Payment;
	/** The local `molliePayment` row after this update. */
	record: MolliePaymentRecord;
	subscription: Subscription;
	plan: MolliePlan | undefined;
	/**
	 * `true` for the small mandate-verification payment of a trial plan. You
	 * may want to refund it or leave it off invoices.
	 */
	isVerification: boolean;
};

/**
 * Extra Mollie payment parameters for the first (mandate) payment. Fields the
 * plugin controls (amount, sequence type, customer, URLs) cannot be overridden.
 */
export type FirstPaymentParams = Omit<
	Partial<PaymentCreateParams>,
	| "amount"
	| "sequenceType"
	| "customerId"
	| "mandateId"
	| "redirectUrl"
	| "cancelUrl"
	| "webhookUrl"
	| "idempotencyKey"
>;

export type SubscriptionOptions = {
	/**
	 * Available plans, or a function returning them.
	 */
	plans: MolliePlan[] | (() => MolliePlan[] | Promise<MolliePlan[]>);
	/**
	 * Who is billed when a request does not pass `customerType`.
	 *
	 * - `"organization"`: the active organization (`session.activeOrganizationId`).
	 *   Requires the Better Auth organization plugin and `authorizeReference`.
	 * - `"user"`: the signed-in user.
	 *
	 * @default "organization"
	 */
	customerType?: CustomerType | undefined;
	/**
	 * Decide whether the signed-in user may act on `referenceId`. Required for
	 * organization billing; also required to pass a `referenceId` other than
	 * the user's own id for user billing.
	 */
	authorizeReference?:
		| ((
				data: {
					user: User & Record<string, any>;
					session: Session & Record<string, any>;
					referenceId: string;
					action: AuthorizeReferenceAction;
				},
				ctx: GenericEndpointContext,
		  ) => Promise<boolean>)
		| undefined;
	/**
	 * Require a verified email before a user can start a subscription.
	 * @default false
	 */
	requireEmailVerification?: boolean | undefined;
	/**
	 * Amount of the first payment for plans with a free trial. It only creates
	 * the mandate. The default is the Bancontact minimum; credit card and
	 * PayPal also accept `"0.00"`.
	 * @default "0.02"
	 */
	verificationAmount?: string | undefined;
	/**
	 * Days after `periodEnd` during which a `past_due` subscription keeps
	 * access. After that, the subscription becomes `unpaid`.
	 * @default 14
	 */
	gracePeriodDays?: number | undefined;
	/**
	 * Customize the first (mandate) payment, e.g. restrict `method`.
	 */
	getFirstPaymentParams?:
		| ((
				data: {
					user: User & Record<string, any>;
					session: Session & Record<string, any>;
					plan: MolliePlan;
					subscription: Subscription;
					isTrial: boolean;
				},
				ctx: GenericEndpointContext,
		  ) => FirstPaymentParams | Promise<FirstPaymentParams>)
		| undefined;
	/**
	 * Runs once when a subscription moves from `incomplete` to `trialing` or
	 * `active` after its first payment is paid.
	 */
	onSubscriptionActivated?:
		| ((
				data: { subscription: Subscription; plan: MolliePlan | undefined; payment: Payment },
				ctx: GenericEndpointContext,
		  ) => Promise<void>)
		| undefined;
	/**
	 * Runs once per payment when it becomes `paid` (first and recurring payments).
	 */
	onPaymentPaid?:
		| ((data: PaymentHookData, ctx: GenericEndpointContext) => Promise<void>)
		| undefined;
	/**
	 * Runs once per payment when it becomes `failed` or `expired`.
	 */
	onPaymentFailed?:
		| ((data: PaymentHookData, ctx: GenericEndpointContext) => Promise<void>)
		| undefined;
	/**
	 * Runs once when a subscription becomes `canceled`: at the end of the
	 * period after `subscription.cancel`, or when Mollie canceled the
	 * subscription itself (for example after repeated payment failures).
	 */
	onSubscriptionCanceled?:
		| ((
				data: {
					subscription: Subscription;
					plan: MolliePlan | undefined;
					reason: "period_ended" | "mollie_canceled";
				},
				ctx: GenericEndpointContext,
		  ) => Promise<void>)
		| undefined;
};

export type SalesInvoiceRecipient = {
	type: "consumer" | "business";
	email: string;
	streetAndNumber: string;
	postalCode: string;
	city: string;
	country: string;
	locale: string;
	givenName?: string | undefined;
	familyName?: string | undefined;
	organizationName?: string | undefined;
	organizationNumber?: string | undefined;
	vatNumber?: string | undefined;
	[key: string]: unknown;
};

export type SalesInvoiceLine = {
	description: string;
	quantity: number;
	/** VAT rate as a string, e.g. `"21.00"`. */
	vatRate: string;
	/** Unit price excluding VAT. */
	unitPrice: { currency: string; value: string };
	[key: string]: unknown;
};

/**
 * Parameters for `POST /v2/sales-invoices`. The plugin sets `status: "paid"`,
 * `paymentDetails`, `metadata` and the idempotency key.
 */
export type SalesInvoiceParams = {
	/** @default the subscription's referenceId */
	recipientIdentifier?: string | undefined;
	recipient: SalesInvoiceRecipient;
	lines: SalesInvoiceLine[];
	/** Deliver through Peppol (Belgium, Germany and the Netherlands). */
	isEInvoice?: boolean | undefined;
	[key: string]: unknown;
};

export type SalesInvoice = {
	id: string;
	invoiceNumber?: string | null;
	status: string;
	[key: string]: unknown;
};

export type SalesInvoicesOptions = {
	enabled: boolean;
	/**
	 * Mollie API key (or access token) used for the Sales Invoices API, which
	 * `@mollie/api-client` does not cover yet.
	 */
	apiKey: string;
	/**
	 * Build the invoice for a paid payment. Return `null` to skip that payment,
	 * e.g. trial verification payments.
	 */
	getInvoiceParams: (
		data: PaymentHookData,
		ctx: GenericEndpointContext,
	) => SalesInvoiceParams | null | Promise<SalesInvoiceParams | null>;
	onInvoiceCreated?:
		| ((
				data: PaymentHookData & { invoice: SalesInvoice },
				ctx: GenericEndpointContext,
		  ) => Promise<void>)
		| undefined;
	/** @default "https://api.mollie.com/v2/" */
	apiEndpoint?: string | undefined;
	/** Custom fetch implementation (useful for tests). */
	fetch?: typeof fetch | undefined;
};

export interface MollieOptions {
	/**
	 * A client created with `createMollieClient` from `@mollie/api-client`.
	 */
	mollieClient: MollieClient;
	/**
	 * Absolute webhook URL Mollie should call. Defaults to
	 * `${baseURL}/mollie/webhook`. Set this when Mollie must reach your app
	 * through a different host, e.g. a tunnel during development.
	 */
	webhookUrl?: string | undefined;
	/**
	 * Create a Mollie customer when a user signs up.
	 * @default false
	 */
	createCustomerOnSignUp?: boolean | undefined;
	getCustomerCreateParams?:
		| ((user: User, ctx: GenericEndpointContext) => Promise<Partial<CustomerCreateParams>>)
		| undefined;
	onCustomerCreate?:
		| ((
				data: { mollieCustomer: Customer; user: User & WithMollieCustomerId },
				ctx: GenericEndpointContext,
		  ) => Promise<void>)
		| undefined;
	subscription?: ({ enabled: false } | ({ enabled: true } & SubscriptionOptions)) | undefined;
	/**
	 * Organization billing. Enabled by default when `subscription.customerType`
	 * is `"organization"` (the default).
	 */
	organization?:
		| {
				enabled?: boolean | undefined;
				getCustomerCreateParams?:
					| ((
							organization: Organization,
							ctx: GenericEndpointContext,
					  ) => Promise<Partial<CustomerCreateParams>>)
					| undefined;
				onCustomerCreate?:
					| ((
							data: {
								mollieCustomer: Customer;
								organization: Organization & WithMollieCustomerId;
							},
							ctx: GenericEndpointContext,
					  ) => Promise<void>)
					| undefined;
		  }
		| undefined;
	/**
	 * Optional: create a Mollie sales invoice with status `paid` for every
	 * paid payment, as proof of payment. Experimental.
	 */
	salesInvoices?: SalesInvoicesOptions | undefined;
	/**
	 * Customize table and field names.
	 */
	schema?: InferOptionSchema<ReturnType<typeof getSchemaDefinition>> | undefined;
}
