# better-auth-mollie

Subscription billing with [Mollie](https://www.mollie.com) for [Better Auth](https://www.better-auth.com).

It follows the API of [`@better-auth/stripe`](https://www.better-auth.com/docs/plugins/stripe): the same endpoints (`subscription.upgrade`, `cancel`, `restore`, `list`), the same subscription statuses and error codes, and the same `referenceId` system for user and organization billing. Moving between the two is mostly a change of imports.

Stripe Billing runs the whole subscription lifecycle for you. Mollie charges a mandate on a schedule: its subscriptions have their own statuses (active, suspended, canceled) and it retries some failed charges, but there is no access lifecycle with grace periods, no proration, no VAT engine and no customer portal. The plugin fills in these gaps itself:

- **Your database is the source of truth.** The `subscription` row holds plan, status and period. Mollie is kept in line with it, and is never trusted blindly.
- **Duplicate charges are refunded.** Mutating Mollie calls go through a write-ahead journal with idempotency keys, so retries and crashes are safe. A payment that pays for something already paid is detected and refunded automatically (see [Known limits](#known-limits)).
- **Upgrades are charged pro rata right away; downgrades start at the next period.**
- **Failed payments get a grace period**, and customers can recover with a new card or bank account.
- **VAT per customer:** a hook, plus an EU VAT helper (`better-auth-mollie/vat`).
- **Optional Mollie sales invoices** for every paid payment, including e-invoicing via Peppol.

> Requires Better Auth `^1.7.18` and Mollie's TypeScript SDK `mollie-api-typescript` `^1.12.44`. The legacy `@mollie/api-client` enters maintenance mode on 17 November 2026 and is not supported.

## Contents

- [Installation](#installation)
- [Plans](#plans)
- [Subscriptions](#subscriptions)
- [Organizations](#organizations)
- [Webhooks](#webhooks)
- [The sync cron](#the-sync-cron)
- [Payment failures and recovery](#payment-failures-and-recovery)
- [VAT](#vat)
- [Invoices](#invoices)
- [Hooks](#hooks)
- [Schema](#schema)
- [Options](#options)
- [Known limits](#known-limits)
- [Compared with @better-auth/stripe](#compared-with-better-authstripe)
- [Testing](#testing)

## Installation

```bash
pnpm add better-auth-mollie mollie-api-typescript
```

Until 1.0, a minor version can change behavior: pin the version, and read the [changelog](CHANGELOG.md) before upgrading. New versions may add database columns, so run your migration with each upgrade.

### Server

```ts
// auth.ts
import { betterAuth } from "better-auth";
import { mollie } from "better-auth-mollie";
import { Client } from "mollie-api-typescript";

export const auth = betterAuth({
	// ...
	plugins: [
		mollie({
			mollieClient: new Client({ security: { apiKey: process.env.MOLLIE_API_KEY! } }),
			createCustomerOnSignUp: true,
			subscription: {
				enabled: true,
				customerType: "user", // or "organization" (the default)
				plans: [
					{ name: "starter", amount: "9.00", interval: "1 month" },
					{ name: "pro", amount: "29.00", interval: "1 month", freeTrial: { days: 14 } },
				],
			},
		}),
	],
});
```

### Client

```ts
// auth-client.ts
import { createAuthClient } from "better-auth/client";
import { mollieClient } from "better-auth-mollie/client";

export const authClient = createAuthClient({
	plugins: [mollieClient({ subscription: true })],
});
```

### Database

The plugin adds three tables (`subscription`, `molliePayment`, `mollieOperation`) and a `mollieCustomerId` field on `user` and `organization`. Generate or run the migration:

```bash
npx @better-auth/cli generate   # or: npx @better-auth/cli migrate
```

**Indexes.** Every run of the sync looks for payments that still need work. Better Auth's schema cannot declare these, so on a large `molliePayment` table add them yourself. For PostgreSQL (partial indexes stay small, since few rows match):

```sql
CREATE INDEX mollie_payment_unsettled_idx ON "molliePayment" ("status", "outcome");
CREATE INDEX mollie_payment_hooks_due_idx ON "molliePayment" ("molliePaymentId") WHERE "hooksDue";
CREATE INDEX mollie_payment_refund_due_idx ON "molliePayment" ("molliePaymentId") WHERE "refundDue";
CREATE INDEX mollie_payment_chargeback_due_idx ON "molliePayment" ("molliePaymentId") WHERE "chargebackDue";
CREATE INDEX mollie_payment_charged_back_idx ON "molliePayment" ("molliePaymentId") WHERE "amountChargedBack" IS NOT NULL;
-- With sales invoices:
CREATE INDEX mollie_payment_uninvoiced_idx ON "molliePayment" ("paidAt") WHERE "invoice" IS NULL;
```

Use your table and column names (e.g. `mollie_payment` and `hooks_due` with snake_case naming).

### Webhooks and the cron

Mollie calls `${baseURL}/mollie/webhook` (for example `https://example.com/api/auth/mollie/webhook`). The plugin sends this URL with every payment and subscription, so there is nothing to configure in the Mollie dashboard. On `localhost`, see [local development](#webhooks). Then schedule the [sync](#the-sync-cron), for example hourly:

```ts
import { syncMollieSubscriptions } from "better-auth-mollie";

await syncMollieSubscriptions(auth);
```

## Plans

```ts
type MolliePlan = {
	name: string; // stored lower-cased on the subscription
	amount: string; // "29.00": net, unless tax.pricesIncludeVat
	currency?: string; // default "EUR"
	interval: string; // Mollie interval: "1 month", "3 months", "12 months", "14 days", "1 week"
	description?: string; // shown on the checkout and bank statement
	limits?: Record<string, unknown>; // returned by subscription.list
	freeTrial?: { days: number };
	archived?: boolean; // no longer offered; its subscribers keep it
};
```

`plans` can also be an async function, for example to load plans from your database. An annual plan is a plan of its own, for example `{ name: "pro-yearly", amount: "290.00", interval: "12 months" }`.

**Changing prices.** To change a price for new customers only, add a plan with the new price (for example `pro-2027`) and set `archived: true` on the old one. New subscriptions and plan changes to an archived plan are refused (`SUBSCRIPTION_PLAN_ARCHIVED`). Its subscribers keep it at their price, and can still cancel, restore, recover after a failed payment, and change to another plan. A checkout started before the plan was archived can still be paid, and starts the subscription on it: the customer agreed to that price, and Mollie expires open checkouts. Leave archived plans out of your pricing page.

Changing a plan's `amount` instead re-prices the subscriptions on it: the sync updates each one's Mollie subscription before its next charge (a charge already in progress keeps the old amount, and an `unpaid` subscription keeps it until it recovers).

Keep every plan that a subscription is on, or is scheduled to change to, in your configuration. Mollie keeps billing a subscription whose plan is missing, and the plugin can no longer bring its Mollie subscription in line (a cancellation still reaches Mollie, and its status still follows its payments). The sync reports it in its `errors` on every run until the plan is back.

## Subscriptions

### Subscribe

```ts
const { data, error } = await authClient.subscription.upgrade({
	plan: "pro",
	successUrl: "/dashboard",
	cancelUrl: "/pricing",
	// referenceId: "org_123",       // who is billed (see Organizations)
	// customerType: "organization",
	// locale: "nl_NL",              // Mollie checkout language
	// metadata: { campaign: "spring" },
});
// Redirects to Mollie's checkout unless `disableRedirect: true`.
```

A new subscription starts with a **first payment** at Mollie's hosted checkout. That payment creates the **mandate** that later charges use.

- **No trial:** the customer pays the first period. Once paid, the subscription is `active`, and a Mollie subscription is scheduled from the end of that period.
- **Trial:** the first payment only verifies the payment method (`verificationAmount`, default `"0.02"`). The subscription is `trialing`, and Mollie starts charging when the trial ends. A reference gets one trial. With `refundVerificationPayment: true` the verification payment is refunded once it created the mandate (what is left of it, if part was refunded by hand; the sync retries a refund that failed), and it is not invoiced, even with `invoiceVerificationPayments`.
- **Trial with a fixed end:** when your app decides the trial, for example one that started when the organization was created, return its end from `subscription.getTrialEnd`. A future `Date` gives a trial until then (rounded up to the next UTC date, when Mollie charges first), also on a plan without `freeTrial` and also when the reference had a trial before; `null` or a past date gives none; `undefined` keeps the plan's `freeTrial`. Return a stable date (not one computed from the current time), since a checkout is only reused for the same trial; a checkout already handed out keeps the trial it was created with. The end is when billing starts: like any trial, access continues through the grace period if the first charge fails:

  ```ts
  subscription: {
  	getTrialEnd: async ({ referenceId, customerType, plan }) =>
  		customerType === "organization" ? await trialEndOf(referenceId) : undefined,
  },
  ```

A reference has one billing subscription at a time. Concurrent checkouts share one pending subscription, and a checkout that is paid while another subscription is already running is refunded instead of starting a second one.

After checkout, Mollie sends the customer to `${baseURL}/subscription/success`. That endpoint syncs the payment, so the subscription is up to date before your `successUrl` loads, without waiting for the webhook.

The customer needs a payment method that can create a mandate: cards, PayPal, or iDEAL, Bancontact, Belfius, KBC, EPS and others when SEPA Direct Debit is enabled on your Mollie profile. Restrict the methods with `getFirstPaymentParams: () => ({ method: "creditcard" })`.

### Change plan

Call `upgrade` with another plan while subscribed:

| Change                                            | When it applies                          | Charged                                                                                                      |
| ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Upgrade: higher price, same interval and currency | Right away                               | The pro-rata difference for the rest of the period, immediately on the mandate. From then on, the new price. |
| Downgrade, or a different interval or currency    | At the end of the period (`pendingPlan`) | The new price from the next period.                                                                          |
| Any change during a trial                         | Right away                               | Nothing now; the new plan's price when the trial ends.                                                       |

Calling `upgrade` with the current plan undoes a scheduled change or a pending cancellation.

### Cancel and restore

```ts
await authClient.subscription.cancel({ returnUrl: "/account" });
await authClient.subscription.restore();
```

Cancelling stops the Mollie subscription right away, so there are no further charges, and access continues until `periodEnd` (`cancelAtPeriodEnd: true`). `restore` undoes this before the period ends by scheduling a new Mollie subscription from `periodEnd`.

### List and check access

```ts
const { data: subscriptions } = await authClient.subscription.list();
// trialing, active and past_due subscriptions, with each plan's `limits`
```

On the server:

```ts
import { hasActiveSubscription } from "better-auth-mollie";

if (await hasActiveSubscription(auth, user.id)) {
	// ...
}
```

`hasActiveSubscription` is true for `trialing`, `active` and `past_due`, including the grace period. For a row you already have, use `hasSubscriptionAccess(subscription, { gracePeriodDays })`. `willBeCharged(subscription)` tells whether the customer will still be charged (billing and not canceled), for example before you delete an account; `BILLING_STATUSES` and `ACCESS_STATUSES` are exported too.

### Statuses

| Status               | Meaning                                                                                  | Access |
| -------------------- | ---------------------------------------------------------------------------------------- | ------ |
| `incomplete`         | Checkout started, first payment not paid yet                                             | No     |
| `incomplete_expired` | First payment failed, expired or was canceled; or no checkout could be created for a day | No     |
| `trialing`           | Free trial; mandate verified                                                             | Yes    |
| `active`             | Paid up                                                                                  | Yes    |
| `past_due`           | A charge failed; within `gracePeriodDays` (default 14)                                   | Yes    |
| `unpaid`             | Grace period over                                                                        | No     |
| `canceled`           | Ended                                                                                    | No     |

`past_due` and `unpaid` return to `active` when a charge or a recovery payment succeeds.

## Organizations

With `customerType: "organization"` (the default), the active organization is billed. This needs Better Auth's organization plugin and an `authorizeReference` callback that decides who may manage billing:

```ts
import { organization } from "better-auth/plugins";

betterAuth({
	plugins: [
		organization(),
		mollie({
			mollieClient,
			subscription: {
				enabled: true,
				plans,
				authorizeReference: async ({ user, referenceId, action }) => {
					const member = await db.member.findFirst({
						where: { organizationId: referenceId, userId: user.id },
					});
					return member?.role === "owner" || member?.role === "admin";
				},
			},
		}),
	],
});
```

Requests bill `referenceId`, or else the session's `activeOrganizationId`. Without either, they fail with `ORGANIZATION_REFERENCE_ID_REQUIRED`; they never fall back to the user. An organization with a billed subscription (trialing, active, past_due or unpaid) cannot be deleted until that subscription is canceled; a pending cancellation (`cancelAtPeriodEnd`) does not block deletion. Changes to an organization's name are synced to its Mollie customer.

For user billing, `authorizeReference` is only needed to let a user act on a `referenceId` other than their own id.

## Webhooks

Mollie's webhook only carries an id (`id=tr_…`). The plugin ignores everything else in the request and fetches the payment or subscription from the Mollie API, so a forged webhook cannot change anything. Processing is idempotent: a payment's status only moves forward, hooks run at most once per change, and repeated or out-of-order deliveries are harmless.

Your hooks run in the background, after the response, through Better Auth's `advanced.backgroundTasks` (for example `waitUntil`) if configured. The webhook itself makes a few Mollie requests, each limited by `requestTimeoutMs` (10 seconds by default). Mollie waits 15 seconds for an answer, so keep that timeout low; a webhook that times out or fails is retried by Mollie, and the sync catches up on anything left over. If something fails (Mollie unreachable), the endpoint answers with an error so that Mollie retries. Payments and changes to the same subscription are processed one at a time; a webhook that finds its subscription busy for longer than `lockWaitMs` gets `409`, and Mollie retries it.

**Local development:** Mollie rejects webhook URLs it cannot reach, such as `localhost`. When `baseURL` is local, the plugin sends no webhook URL and logs a warning. The success redirect then syncs the first payment, and the cron syncs everything else. To receive webhooks locally, use a tunnel and point `webhookUrl` at it:

```ts
mollie({ mollieClient, webhookUrl: "https://abc123.ngrok.app/api/auth/mollie/webhook", ... })
```

## The sync cron

Mollie's webhooks are reliable but not guaranteed, and some changes depend only on the clock: a period ends, a grace period runs out, a scheduled plan change starts. Run the sync regularly; hourly is a good default:

```ts
import { syncMollieSubscriptions } from "better-auth-mollie";

// e.g. in a cron route, a queue job or `setInterval` on a single instance
const result = await syncMollieSubscriptions(auth);
// { checked, remoteChecked, invoicesCreated, errors: [{ subscriptionId, message }] }
```

It is cheap: a stable subscription is only fetched from Mollie in the day before its next payment, or when a change still has to reach Mollie. A `past_due` one is checked on every run, an `unpaid` one once a day. The sync:

- processes payments whose webhook was missed;
- applies clock-based transitions;
- finishes interrupted changes;
- moves billing to a new plan, mandate or VAT rate;
- refunds duplicates whose refund failed earlier;
- cancels stray Mollie subscriptions;
- creates [sales invoices](#invoices) that were missed.

Running it concurrently with webhooks or with itself is safe.

To bring one user or organization up to date right away, for example from a "refresh" button in your support tools or after changing something by hand, pass its id. Its subscriptions are then checked at Mollie whatever their schedule; the profile-wide chargeback listing is left to the regular sync:

```ts
await syncMollieSubscriptions(auth, { referenceId: organizationId });
```

If a user and an organization can share an id (custom ids), pass `customerType: "organization"` (or `"user"`) to sync only that one.

**From a background worker.** The sync needs a Better Auth instance with the same configuration as your app (database, secret, plugins including `mollie` and, for organization billing, `organization`). Create one in the worker the way the app does, for example with a shared `createAuth()` function, and call `syncMollieSubscriptions(auth)` from its scheduled handler. Hooks run in the background, so give that instance an `advanced.backgroundTasks.handler` that keeps the worker alive until they finish (for example `ctx.waitUntil`). It does not serve requests, so the app's base URL only matters for the webhook URL it sends to Mollie: use the same `baseURL`.

## Payment failures and recovery

When a renewal fails, the subscription becomes `past_due` and keeps access for `gracePeriodDays`, then becomes `unpaid`. A later successful charge makes it `active` again. The customer can also recover by calling `upgrade` with their plan:

```ts
await authClient.subscription.upgrade({ plan: "pro", successUrl: "/dashboard" });
```

This starts a checkout for the full price with a new mandate. Once it is paid, the subscription is `active` again with a fresh period, and Mollie bills the new mandate from then on. The plugin refuses (`PAYMENT_IN_PROGRESS`) while Mollie is still collecting a charge. If a charge pays for a period that was already paid, it is refunded and `onDuplicatePayment` runs.

**Chargebacks.** A customer can take a payment back: a disputed card payment, or a reversed SEPA Direct Debit (consumers can reverse any debit within 8 weeks). When that payment paid for the period that is running, the period counts as unpaid, as if its charge had failed: the subscription becomes `past_due`, `periodEnd` moves back to the start of that period, and the grace period counts from there. A charged-back pro-rata charge counts as a failed one. The next successful charge or a recovery checkout makes it `active` again. A chargeback of an earlier period's payment (also the last paid one while a failed renewal is in its grace period), or of a trial's verification payment, changes nothing. In each case `onChargeback` runs, also when a chargeback is reversed (`chargeback.reversed`). A reversal does not restore the subscription: the customer pays again through `upgrade`, and you can refund them yourself. Mollie calls the payment's webhook for chargebacks; in case one never arrived, the sync also lists the profile's chargebacks of the last 120 days and rechecks payments with a chargeback created or reversed in the last 14 days, and looks at each recorded chargeback once a day for a reversal (for up to 18 months after the payment).

If Mollie itself cancels a subscription, for example after repeated SEPA failures:

- an `active` or `trialing` subscription ends at `periodEnd`;
- a `past_due` or `unpaid` one ends right away (`onSubscriptionCanceled` with `reason: "mollie_canceled"`).

## VAT

Mollie charges exactly the amount it is given; it does not add VAT. Configure `subscription.tax` to charge the right amount per customer:

```ts
subscription: {
	enabled: true,
	plans,
	tax: {
		pricesIncludeVat: false, // plan amounts are net (default)
		calculate: async ({ referenceId, customerType, plan }) => ({
			rate: "21.00",
			country: "NL",
			// reverseCharge: true, with rate "0.00", for intra-EU B2B
		}),
	},
}
```

### EU VAT helper

`better-auth-mollie/vat` implements the EU rules on top of [`sales-tax`](https://www.npmjs.com/package/sales-tax):

- EU consumers pay their own country's rate (OSS).
- EU businesses in another member state with a valid VAT number pay no VAT (reverse charge). Numbers are checked with VIES by default; if VIES is down, VAT is charged.
- Domestic businesses pay your rate.
- Customers outside the EU pay no VAT, unless you list the country in `registeredCountries`.
- Unknown customers pay your own rate.

```ts
import { euVat } from "better-auth-mollie/vat";

tax: euVat({
	originCountry: "NL",
	getCustomer: async ({ referenceId, customerType }) => {
		const billing = await db.billingDetails.findUnique({ where: { referenceId } });
		return billing ? { country: billing.country, vatNumber: billing.vatNumber } : null;
	},
	// vies: true,               // verify VAT numbers online (default)
	// belowOssThreshold: false, // under €10,000 EU-wide: charge your own rate
	// registeredCountries: ["CH"],
}),
```

Amounts are computed in whole cents, rounding half up. Every payment and Mollie subscription carries its breakdown in its metadata (`vatRate`, `netAmount`, `vatAmount`, `grossAmount`, `reverseCharge`), and hooks receive it as `tax`. When a customer's VAT changes, for example after they add a VAT number, the next sync moves billing to the new amount from the next period.

The rates are only as current as the `sales-tax` package. You remain responsible for your VAT filings.

## Invoices

Mollie Billing does not create invoices. Choose one of two ways.

**Your own invoices** in `onPaymentPaid`:

```ts
onPaymentPaid: async ({ payment, subscription, plan, tax, purpose, isVerification }) => {
	if (isVerification) return; // the €0.02 trial verification
	await invoices.create({ ... });
},
```

**Mollie sales invoices**, created automatically with status `paid` for each paid payment:

```ts
mollie({
	// ...
	salesInvoices: {
		enabled: true,
		getRecipient: async ({ subscription }) => ({
			type: "business",
			organizationName: "Acme BV",
			vatNumber: "NL004495445B01",
			email: "billing@acme.test",
			streetAndNumber: "Keizersgracht 1",
			postalCode: "1015 CJ",
			city: "Amsterdam",
			country: "NL",
			locale: "nl_NL",
		}),
		eInvoice: true, // deliver via Peppol (BE, DE, NL)
		// reverseChargeMemo: "VAT reverse charged", // the memo when VAT is reverse charged
		// vatRate: "21.00", // required when `subscription.tax` is not configured
		// invoiceVerificationPayments: false,
		// getInvoiceParams: (data, request) => ({ ...request, memo: "Thank you!" }),
		// onInvoiceCreated: async ({ invoice }) => { ... },
	},
});
```

Invoice lines use the VAT that was actually charged, including reverse charge. Each payment is invoiced at most once, and invoices that failed are retried by the sync for 30 days. Duplicates that were refunded are not invoiced. When `getRecipient` returns `null`, that payment is never invoiced; throw instead to have the sync try again later.

The plugin does not issue credit notes. A payment that is charged back (or refunded by hand) keeps its paid invoice; credit it in your accounting if you need to. `onChargeback` receives the payment's `record.salesInvoiceId`.

## Hooks

```ts
subscription: {
	onSubscriptionActivated: async ({ subscription, plan, payment }) => {}, // first payment, or a recovery
	onPaymentPaid: async (data) => {},       // every paid payment
	onPaymentFailed: async (data) => {},     // failed or expired
	onDuplicatePayment: async (data) => {},  // `data.refunded` tells whether it was refunded
	onChargeback: async (data) => {},        // `data.chargeback`: { amount, reversed }
	onSubscriptionCanceled: async ({ subscription, plan, reason }) => {},
},
onCustomerCreate: async ({ mollieCustomer, user }) => {},
```

Payment hooks receive `{ payment, purpose, record, subscription, plan, isVerification, tax }`. `purpose` is one of `checkout`, `verification`, `renewal`, `proration` or `recovery`. `plan` (in every hook) is `undefined` when the plan is no longer configured or a `plans` function cannot be loaded at that moment: the hook still runs.

Hooks run at most once per change, after the change is stored. A failing hook is logged and not retried, and it does not stop other hooks. If the process stops between storing a change and running its hooks, those hooks do not run. Don't rely on a hook alone for anything that must happen:

- **Invoices:** use `salesInvoices`, which the sync retries; or make your own invoicing idempotent, keyed by the payment id, and catch up from the `molliePayment` table (`status: "paid"`, `outcome: "applied"`).
- **Access:** derive it from the `subscription` row, as `hasActiveSubscription` and `hasSubscriptionAccess` do, not from hook calls.

## Schema

**`subscription`**

| Field                                    | Type                 | Notes                                                    |
| ---------------------------------------- | -------------------- | -------------------------------------------------------- |
| `id`                                     | string               |                                                          |
| `referenceId`                            | string               | User or organization id                                  |
| `plan`                                   | string               | Lower-cased plan name                                    |
| `pendingPlan`                            | string?              | Scheduled plan change, applied at `periodEnd`            |
| `status`                                 | string               | See [Statuses](#statuses)                                |
| `mollieCustomerId`                       | string?              | `cst_…`                                                  |
| `mollieMandateId`                        | string?              | `mdt_…`                                                  |
| `mollieSubscriptionId`                   | string?              | `sub_…`                                                  |
| `periodStart`, `periodEnd`, `trialEnd`   | date?                |                                                          |
| `cancelAtPeriodEnd`                      | boolean              |                                                          |
| `customerType`                           | string?              | `user` or `organization`                                 |
| `appliedPaymentId`                       | string?              | The payment that last activated, recovered or renewed it |
| `mollieSyncNeeded`, `mollieSyncRevision` | boolean, number      | Internal: a change still to reach Mollie                 |
| `mollieCheckedAt`                        | date?                | Internal: when the sync last checked an `unpaid` one     |
| `lockToken`, `lockedUntil`, `lockSerial` | string, date, number | Internal: lease of whoever is changing the subscription  |
| `createdAt`, `updatedAt`                 | date                 |                                                          |

**`molliePayment`**: `molliePaymentId` (unique), `subscriptionId`, `amount`, `currency`, `status`, `sequenceType`, `paidAt`, `failedAt`, `createdAt` (when Mollie created it), `purpose` (see [Hooks](#hooks); once set, it decides how the payment is handled, over its Mollie metadata, so payments imported from earlier billing can carry it), `outcome` (`pending`, `applied`, `duplicate`, `refunded`, `kept`, or `handled` for a payment that was not paid), `invoice` (`created`, or `skipped` for a payment that is not invoiced) and `salesInvoiceId`, `paidThrough` (the end of the period it paid for), `amountChargedBack` (charged back and not reversed), and internally `claimSerial`, `hooksDue`, `chargebackDue`, `chargebackCheckedAt` and `refundDue`.

**`mollieOperation`**: the journal of Mollie calls (`idempotencyKey`, `kind`, `referenceId`, `status`, `mollieId`, `createdAt`). The plugin uses it to resume interrupted calls and to recognize its own cancellations and invoices, so keep its rows.

**`user`**, **`organization`**: `mollieCustomerId`.

Rename tables or fields with the `schema` option, as in other Better Auth plugins.

## Options

| Option                                                                  | Default                     |                                                                                                                                                                      |
| ----------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mollieClient`                                                          | required                    | `new Client({ security: { apiKey } })` from `mollie-api-typescript`                                                                                                  |
| `webhookUrl`                                                            | `${baseURL}/mollie/webhook` | Override, for example for a tunnel                                                                                                                                   |
| `requestTimeoutMs`                                                      | `10000`                     | Per Mollie request; the SDK has no timeout of its own                                                                                                                |
| `lockWaitMs`                                                            | `5000`                      | How long a request or webhook waits for a busy subscription before `OPERATION_IN_PROGRESS` (webhooks: `409`, retried by Mollie)                                      |
| `createCustomerOnSignUp`                                                | `false`                     | Otherwise customers are created at the first checkout                                                                                                                |
| `getCustomerCreateParams`, `onCustomerCreate`                           |                             | Customize the Mollie customer for users                                                                                                                              |
| `organization.getCustomerCreateParams`, `organization.onCustomerCreate` |                             | The same, for organizations                                                                                                                                          |
| `subscription.enabled`                                                  |                             |                                                                                                                                                                      |
| `subscription.plans`                                                    | required                    | Array or (async) function, called when plans are needed and checked before anything new is billed                                                                    |
| `subscription.customerType`                                             | `"organization"`            | Default billed party                                                                                                                                                 |
| `subscription.authorizeReference`                                       |                             | Required for organization billing                                                                                                                                    |
| `subscription.requireEmailVerification`                                 | `false`                     |                                                                                                                                                                      |
| `subscription.verificationAmount`                                       | `"0.02"`                    | First payment of a trial; `"0.00"` works for cards and PayPal                                                                                                        |
| `subscription.gracePeriodDays`                                          | `14`                        | `past_due` keeps access this long                                                                                                                                    |
| `subscription.getFirstPaymentParams`                                    |                             | For example `{ method: "creditcard" }`                                                                                                                               |
| `subscription.serverOnly`                                               | `false`                     | `upgrade`, `cancel` and `restore` only through `auth.api`, e.g. when your own action collects consent first (the client still lists them; over HTTP they answer 404) |
| `subscription.tax`                                                      |                             | See [VAT](#vat)                                                                                                                                                      |
| `subscription.refundDuplicatePayments`                                  | `true`                      |                                                                                                                                                                      |
| `subscription.refundVerificationPayment`                                | `false`                     | Refund a trial's verification payment once the mandate exists                                                                                                        |
| `subscription.refundDescription`                                        | English text                | `({ reason, payment, subscription }) => string`: the description of a refund, e.g. translated                                                                        |
| `subscription.getTrialEnd`                                              |                             | When a new subscription's trial ends, decided by your app (see [Subscribe](#subscribe))                                                                              |
| `subscription.on…`                                                      |                             | See [Hooks](#hooks)                                                                                                                                                  |
| `salesInvoices`                                                         |                             | See [Invoices](#invoices)                                                                                                                                            |
| `schema`                                                                |                             | Rename tables and fields                                                                                                                                             |

Error codes are exported as `MOLLIE_ERROR_CODES` and reuse the Stripe plugin's names where the meaning is the same, for example `SUBSCRIPTION_NOT_FOUND`, `ALREADY_SUBSCRIBED_PLAN` and `ORGANIZATION_REFERENCE_ID_REQUIRED`. Mollie-specific codes include `PAYMENT_IN_PROGRESS`, `OPERATION_IN_PROGRESS`, `MANDATE_NOT_FOUND`, `SUBSCRIPTION_PERIOD_ENDED`, `SUBSCRIPTION_PLAN_ARCHIVED` and `ANOTHER_SUBSCRIPTION_ACTIVE`.

## Known limits

The billing logic is tested against a stateful fake of the Mollie SDK (including crashes, lost responses, stalled processes and concurrent deliveries) and against Mollie test mode. It is new: watch the sync's errors closely when you start using it.

- **Run the sync, and watch it.** Missed webhooks, refunds that failed, interrupted changes, missed sales invoices and hooks still marked as due are completed by `syncMollieSubscriptions`. Run it at least hourly and alert on its `errors`, which include refunds that are still due and invoices that failed: one that keeps coming back needs a look. The plugin also logs every failure through Better Auth's logger.
- **Eventually consistent, not instant.** A duplicate charge is refunded once it is detected (usually by its webhook, at the latest by the sync), so a customer can briefly be charged twice before the refund goes out.
- **Hooks are best effort.** `onPaymentPaid` and the other hooks run at most once; a crash at the wrong moment loses one. Derive access from the subscription (`hasActiveSubscription`, `hasSubscriptionAccess`), and make your own invoicing idempotent or use `salesInvoices`, which the sync retries for 30 days. Older missed invoices need manual recovery.
- **Keep the plugin's data.** Do not delete `subscription`, `molliePayment` or `mollieOperation` rows, and run the migration before deploying a new version (new columns are not backfilled).
- **Your database must support atomic guarded updates and unique fields.** The plugin relies on Better Auth's `incrementOne` with conditions, and on a second insert of a unique field failing (its locks and payment records). Every test runs on SQLite (Kysely); other SQL adapters, Prisma, Drizzle and MongoDB should behave the same but are not tested here.
- **The memory adapter is for development and tests only.** It does not enforce unique fields, so the plugin's guarantees against concurrent requests do not hold on it, and it orders strings differently when sorting and when comparing. The plugin logs a warning when it runs on it. The unit tests also run on it (`pnpm test:memory`), except those that need unique fields.
- **Clocks.** Lock leases and deadlines use the application servers' clocks; keep them in sync (NTP).

## Compared with @better-auth/stripe

|                    | `@better-auth/stripe`                                                | `better-auth-mollie`                                                    |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Endpoints          | `subscription.upgrade`, `cancel`, `restore`, `list`, `billingPortal` | `subscription.upgrade`, `cancel`, `restore`, `list`                     |
| Checkout           | Stripe Checkout session                                              | Mollie hosted checkout (first payment creates the mandate)              |
| Recurring charges  | Stripe Billing                                                       | Mollie Subscriptions API; state kept in your database                   |
| Trials             | Stripe trial                                                         | Verification payment (€0.02 by default), then billed from the trial end |
| Upgrades           | Stripe proration settings                                            | Immediate; pro-rata difference charged right away                       |
| Downgrades         | Stripe proration settings                                            | From the next period (`pendingPlan`)                                    |
| Cancel             | At period end, via Stripe or the portal                              | At period end; Mollie billing stops right away                          |
| Failed payments    | Smart Retries, dunning emails                                        | `past_due` + grace period → `unpaid`; recovery checkout via `upgrade`   |
| Customer portal    | Stripe Billing Portal                                                | None: build your own with `list`, `upgrade`, `cancel` and `restore`     |
| Seats / quantities | Yes                                                                  | No                                                                      |
| Annual discount    | `annualDiscountPriceId`                                              | A separate plan, for example `interval: "12 months"`                    |
| Tax                | Stripe Tax                                                           | `tax.calculate` hook, or the `euVat()` helper                           |
| Invoices           | Stripe invoices                                                      | `onPaymentPaid`, or Mollie sales invoices (with Peppol)                 |
| Webhook            | Signed events at `/stripe/webhook`                                   | Id-only pings at `/mollie/webhook`; the state is fetched from Mollie    |
| Cron               | Not needed                                                           | `syncMollieSubscriptions`, hourly recommended                           |
| Duplicate payments | Handled by Stripe                                                    | Detected and refunded automatically                                     |
| Chargebacks        | Disputes, reported by webhook                                        | Of the current period: like a failed charge; always `onChargeback`      |
| Price changes      | A new Price; existing subscriptions keep theirs                      | A new plan, and `archived: true` on the old one                         |
| Payment methods    | Cards, SEPA DD, …                                                    | Cards, PayPal, SEPA DD (via iDEAL, Bancontact, …)                       |

## Testing

```bash
pnpm test                 # unit tests, against a stateful fake of the Mollie SDK
pnpm test:memory          # the same, on Better Auth's memory adapter
pnpm test:integration     # against Mollie test mode
```

The integration test uses a real test-mode profile. It drives Mollie's hosted checkout and test-mode status pages with Playwright (`pnpm exec playwright install chromium`):

```bash
MOLLIE_TEST_API_KEY=test_... pnpm test:integration
# MOLLIE_TEST_METHOD=bancontact if SEPA Direct Debit is enabled; default creditcard
```

It checks the real customer, first payment, mandate, subscription schedule, a recurring payment, cancellation and the sync. It cancels the Mollie subscriptions it creates.

## License

MIT © Gijs Rommers
