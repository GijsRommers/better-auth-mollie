import type { GenericEndpointContext, InferOptionSchema, Session, User } from "better-auth";
import type { Organization } from "better-auth/plugins/organization";
import type { Client } from "mollie-api-typescript";
import type {
	CustomerResponse,
	EntityCustomer,
	PaymentRequest,
	SalesInvoiceRecipient,
	SalesInvoiceRequest,
	SalesInvoiceResponse,
} from "mollie-api-typescript/models";
import type { MolliePayment } from "./gateway";
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
	/**
	 * A scheduled plan change (downgrade, or a different interval): billed
	 * from `periodEnd`, and becomes `plan` at `periodEnd`.
	 */
	pendingPlan?: string | null | undefined;
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
	/** Who is billed, as chosen when the subscription was started. */
	customerType?: CustomerType | null | undefined;
	/** The payment that last activated, recovered or renewed this subscription. */
	appliedPaymentId?: string | null | undefined;
	/**
	 * A change that Mollie still has to follow (new plan, mandate, cancellation,
	 * …). Cleared once Mollie matches; the sync retries rows that keep it.
	 */
	mollieSyncNeeded?: boolean | null | undefined;
	/** Incremented with every change that sets `mollieSyncNeeded`. */
	mollieSyncRevision?: number | null | undefined;
	/** Internal: the lease of whoever is changing this subscription (see `withSubscriptionLock`). */
	lockToken?: string | null | undefined;
	lockedUntil?: Date | null | undefined;
	lockSerial?: number | null | undefined;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * What a paid payment did for its subscription:
 * - `pending`: not decided yet (or the payment is not paid);
 * - `applied`: it paid for the subscription;
 * - `duplicate`: it paid for something already paid; a refund is due;
 * - `refunded`: such a duplicate, refunded;
 * - `kept`: such a duplicate, kept (`refundDuplicatePayments: false`);
 * - `handled`: not paid (failed, expired, canceled), and what that means for
 *   the subscription (past due, checkout over) has been applied.
 */
export type PaymentOutcome = "pending" | "applied" | "duplicate" | "refunded" | "kept" | "handled";

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
	outcome: PaymentOutcome;
	/** Internal: the newest subscription lock that claimed this payment (see `claimPayment`). */
	claimSerial?: number | null | undefined;
	/** Internal: its `payment.paid` / `payment.failed` hooks are still to be dispatched. */
	hooksDue?: boolean | null | undefined;
}

export type MollieOperationStatus = "pending" | "succeeded" | "failed";

export type MollieOperationKind =
	| "create_customer"
	| "create_first_payment"
	| "create_subscription"
	| "cancel_subscription"
	| "create_proration_payment"
	| "create_refund"
	| "create_sales_invoice"
	/** Marks a hook as delivered, so it runs at most once. */
	| "hook_delivery"
	/** Lease lock serializing changes to one subscription. */
	| "lifecycle_lock";

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

/**
 * Why a payment exists:
 * - `checkout`: first payment of a new subscription (pays the first period)
 * - `verification`: first payment of a trial (only creates the mandate)
 * - `renewal`: charged by the Mollie subscription each period
 * - `proration`: the pro-rata difference charged on an upgrade
 * - `recovery`: a new first payment that restarts a past-due subscription
 */
export type PaymentPurpose = "checkout" | "verification" | "renewal" | "proration" | "recovery";

export type PaymentHookData = {
	/** The payment exactly as fetched from the Mollie API. */
	payment: MolliePayment;
	purpose: PaymentPurpose;
	/** The local `molliePayment` row after this update. */
	record: MolliePaymentRecord;
	subscription: Subscription;
	plan: MolliePlan | undefined;
	/**
	 * `true` for the small mandate-verification payment of a trial plan. You
	 * may want to refund it or leave it off invoices.
	 */
	isVerification: boolean;
	/**
	 * VAT breakdown of this payment when `subscription.tax` is configured
	 * (`null` otherwise, and for verification payments).
	 */
	tax: TaxBreakdown | null;
};

/**
 * The tax treatment of a customer, returned by `subscription.tax.calculate`.
 */
export type TaxDecision = {
	/**
	 * VAT rate in percent with two decimals, e.g. `"21.00"`. Use `"0.00"` for
	 * reverse charge and exempt customers.
	 */
	rate: string;
	/** ISO 3166-1 alpha-2 country of the customer, kept for your records. */
	country?: string | undefined;
	/** Intra-EU B2B supply: VAT is accounted for by the customer. */
	reverseCharge?: boolean | undefined;
};

/** Amounts of one charge, as decimal strings in `currency`. */
export type TaxBreakdown = {
	rate: string;
	net: string;
	vat: string;
	gross: string;
	currency: string;
	country?: string | undefined;
	reverseCharge: boolean;
	/** The price was VAT-inclusive (VAT was computed out of `gross`). */
	inclusive: boolean;
};

export type TaxOptions = {
	/**
	 * Whether plan amounts include VAT.
	 * - `false` (default): plan amounts are net; the customer pays net + VAT.
	 * - `true`: plan amounts are what the customer pays; VAT is included.
	 * @default false
	 */
	pricesIncludeVat?: boolean | undefined;
	/**
	 * Decide the VAT treatment for a billing reference. Called when a
	 * subscription starts, changes plan or is restored. Use the bundled
	 * `euVat()` helper from `better-auth-mollie/vat`, or your own logic.
	 */
	calculate: (
		data: { referenceId: string; customerType: CustomerType; plan: MolliePlan },
		ctx: GenericEndpointContext,
	) => TaxDecision | Promise<TaxDecision>;
};

/**
 * Extra Mollie payment parameters for the first (mandate) payment. Fields the
 * plugin controls (amount, sequence type, customer, URLs) cannot be overridden.
 */
export type FirstPaymentParams = Omit<
	Partial<PaymentRequest>,
	| "amount"
	| "sequenceType"
	| "customerId"
	| "mandateId"
	| "redirectUrl"
	| "cancelUrl"
	| "webhookUrl"
	| "testmode"
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
	 * VAT handling. Mollie charges exactly the amount it is given and does not
	 * compute VAT, so configure this to charge net + VAT per customer.
	 */
	tax?: TaxOptions | undefined;
	/**
	 * Runs once when a subscription moves from `incomplete` to `trialing` or
	 * `active` after its first payment is paid.
	 */
	onSubscriptionActivated?:
		| ((
				data: { subscription: Subscription; plan: MolliePlan | undefined; payment: MolliePayment },
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
	 * Refund a payment that paid for something already paid (e.g. a recovery
	 * checkout that raced Mollie's own successful retry, or two checkouts
	 * paid in different tabs).
	 * @default true
	 */
	refundDuplicatePayments?: boolean | undefined;
	/**
	 * Runs once when a payment turns out to pay for something already paid,
	 * after it was refunded (unless `refundDuplicatePayments` is false).
	 */
	onDuplicatePayment?:
		| ((
				data: PaymentHookData & { refunded: boolean },
				ctx: GenericEndpointContext,
		  ) => Promise<void>)
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

export type SalesInvoicesOptions = {
	enabled: boolean;
	/**
	 * The invoice recipient for a paid payment, from your own customer data
	 * (Mollie requires name, email and address). Return `null` to skip.
	 */
	getRecipient: (
		data: PaymentHookData,
		ctx: GenericEndpointContext,
	) => SalesInvoiceRecipient | null | Promise<SalesInvoiceRecipient | null>;
	/**
	 * VAT rate for invoice lines when `subscription.tax` is not configured
	 * (prices are then treated as VAT-inclusive). Required in that case.
	 */
	vatRate?: string | undefined;
	/** Deliver invoices through Peppol (Belgium, Germany and the Netherlands). */
	eInvoice?: boolean | undefined;
	/**
	 * Also invoice the small mandate-verification payment of trial plans.
	 * @default false
	 */
	invoiceVerificationPayments?: boolean | undefined;
	/** Adjust the request before it is sent, e.g. add a memo or discount. */
	getInvoiceParams?:
		| ((
				data: PaymentHookData,
				defaults: SalesInvoiceRequest,
				ctx: GenericEndpointContext,
		  ) => SalesInvoiceRequest | Promise<SalesInvoiceRequest>)
		| undefined;
	onInvoiceCreated?:
		| ((
				data: PaymentHookData & { invoice: SalesInvoiceResponse },
				ctx: GenericEndpointContext,
		  ) => Promise<void>)
		| undefined;
};

export interface MollieOptions {
	/**
	 * A client from Mollie's TypeScript SDK (`mollie-api-typescript`), e.g.
	 * `new Client({ security: { apiKey: process.env.MOLLIE_API_KEY } })`.
	 */
	mollieClient: Client;
	/**
	 * Absolute webhook URL Mollie should call. Defaults to
	 * `${baseURL}/mollie/webhook`. Set this when Mollie must reach your app
	 * through a different host, e.g. a tunnel during development.
	 */
	webhookUrl?: string | undefined;
	/**
	 * Timeout for each Mollie API request, in milliseconds. The SDK has none
	 * of its own; a bounded request keeps webhooks within Mollie's 15-second
	 * limit and the operation journal's assumptions valid.
	 * @default 10000
	 */
	requestTimeoutMs?: number | undefined;
	/**
	 * How long a request or webhook waits for a subscription that is busy
	 * (another payment, a plan change, the sync) before giving up with
	 * `OPERATION_IN_PROGRESS` (a webhook then gets 409 and Mollie retries).
	 * @default 5000
	 */
	lockWaitMs?: number | undefined;
	/**
	 * Create a Mollie customer when a user signs up.
	 * @default false
	 */
	createCustomerOnSignUp?: boolean | undefined;
	getCustomerCreateParams?:
		| ((user: User, ctx: GenericEndpointContext) => Promise<Partial<EntityCustomer>>)
		| undefined;
	onCustomerCreate?:
		| ((
				data: { mollieCustomer: CustomerResponse; user: User & WithMollieCustomerId },
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
					  ) => Promise<Partial<EntityCustomer>>)
					| undefined;
				onCustomerCreate?:
					| ((
							data: {
								mollieCustomer: CustomerResponse;
								organization: Organization & WithMollieCustomerId;
							},
							ctx: GenericEndpointContext,
					  ) => Promise<void>)
					| undefined;
		  }
		| undefined;
	/**
	 * Create a Mollie sales invoice (status `paid`) for every paid payment,
	 * as proof of payment. Opt-in.
	 */
	salesInvoices?: SalesInvoicesOptions | undefined;
	/**
	 * Customize table and field names.
	 */
	schema?: InferOptionSchema<ReturnType<typeof getSchemaDefinition>> | undefined;
}
