# Changelog

All notable changes to `better-auth-mollie`. The project follows [semantic versioning](https://semver.org); until 1.0, a minor version may break things, and every release says so here.

## 0.1.0-alpha.0

The first public release. Not yet run in production: see [Known limits](README.md#known-limits).

- Subscriptions for users and organizations through Mollie: checkout with a mandate, recurring charges with the Subscriptions API, cancel at period end and restore, the same API as `@better-auth/stripe`.
- Plan changes: upgrades right away with a pro-rata charge, downgrades from the next period; archived plans for price changes.
- Trials with a verification payment, optionally refunded (`refundVerificationPayment`), lasting a number of days or until a date the app decides (`getTrialEnd`).
- Failed payments: `past_due` with a grace period, then `unpaid`; recovery through a new checkout. Chargebacks of the current period count as failed charges (`onChargeback`).
- Safety: a write-ahead journal for every Mollie call, row locks with fencing, duplicate payments refunded automatically, and an hourly sync (`syncMollieSubscriptions`) as the fallback for missed webhooks, also for one user or organization at a time.
- VAT per customer through a hook, with an EU VAT helper (`better-auth-mollie/vat`), and optional Mollie sales invoices with Peppol e-invoicing.
- Tested against a stateful fake of the Mollie SDK (on SQLite and Better Auth's memory adapter) and against Mollie test mode with card and iDEAL.
