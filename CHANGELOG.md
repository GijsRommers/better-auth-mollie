# Changelog

All notable changes to `better-auth-mollie`. The project follows [semantic versioning](https://semver.org); until 1.0, a minor version may break things, and every release says so here.

## Unreleased

- Released subscription locks now use `NULL` instead of the Unix epoch, which MySQL TIMESTAMP rejects. The existing nullable column needs no migration; older expired leases remain supported.
- Run billing regressions across eight SQL engine/adapter combinations in CI. Prisma 6/MySQL is explicitly incompatible because a losing guarded update can return a stale row; retain a separate expected-failure contract diagnostic. Add disposable local databases and `pnpm test:adapters`.
- Fix synchronization in the operation replay test: wait for the original outbound call before starting its retry, so the retry cannot consume the original call's pause.
- Separate clock-driven transitions from sync orchestration and document the lifecycle invariants and operational validation steps.

## 0.2.0

No breaking changes and no schema changes.

- The purpose recorded with a payment (`molliePayment.purpose`) now decides how it is handled, over its Mollie metadata. A payment imported from earlier billing, such as a trial's verification payment without the plugin's metadata, is then handled as what it was: a chargeback of it no longer suspends the trial. A first payment whose recorded purpose does not match its trial terms starts nothing: it stays unprocessed and is logged.
- `subscription.refundDescription`: the description of the refunds the plugin makes (duplicates and verification payments), e.g. in the customer's language.
- README: the indexes the sync needs on a large `molliePayment` table, and that charged-back payments keep their sales invoice (the plugin issues no credit notes).

## 0.1.0

The first public release. See [Known limits](README.md#known-limits).

- Subscriptions for users and organizations through Mollie: checkout with a mandate, recurring charges with the Subscriptions API, cancel at period end and restore, the same API as `@better-auth/stripe`.
- Plan changes: upgrades right away with a pro-rata charge, downgrades from the next period; archived plans for price changes.
- Trials with a verification payment, optionally refunded (`refundVerificationPayment`), lasting a number of days or until a date the app decides (`getTrialEnd`).
- Failed payments: `past_due` with a grace period, then `unpaid`; recovery through a new checkout. Chargebacks of the current period count as failed charges (`onChargeback`).
- Safety: a write-ahead journal for every Mollie call, row locks with fencing, duplicate payments refunded automatically, and an hourly sync (`syncMollieSubscriptions`) as the fallback for missed webhooks, also for one user or organization at a time.
- VAT per customer through a hook, with an EU VAT helper (`better-auth-mollie/vat`), and optional Mollie sales invoices with Peppol e-invoicing.
- Tested against a stateful fake of the Mollie SDK (on SQLite and Better Auth's memory adapter) and against Mollie test mode with card and iDEAL.
