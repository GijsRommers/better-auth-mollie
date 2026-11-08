# Billing lifecycle and recovery

The subscription row owns access and billing intent. A Mollie payment is an
observation to apply to that intent, not permission to overwrite it. A status
alone is insufficient: period dates, payment purpose, cancellation intent and
the current remote subscription determine whether a payment applies.

## Transition boundaries

| Trigger                               | Local effect                                         | Conditions that matter                                                                  |
| ------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Paid first checkout                   | `incomplete` → `active`                              | Valid plan and mandate; no other subscription covers the billing identity.              |
| Paid trial verification               | `incomplete` → `trialing`                            | Recorded purpose agrees with the checkout's trial terms.                                |
| Paid renewal                          | Billing status → `active`; advance period            | Current remote subscription, uncovered billing cycle, no pending cancellation.          |
| Failed renewal or proration           | `trialing` / `active` → `past_due`                   | Failure belongs to a relevant, unpaid period. Old failures cannot undo later payments.  |
| Paid recovery                         | `past_due` / `unpaid` → `active`                     | Fresh period and mandate; no later cancellation or recovery superseded it.              |
| Cancel request                        | Set `cancelAtPeriodEnd`; stop remote billing         | Access continues until `periodEnd`. Local intent survives a remote failure.             |
| Restore request                       | Clear pending cancellation; reconcile remote billing | Must still be before the cancellation takes effect.                                     |
| Period ends with pending cancellation | Billing status → `canceled`                          | Apply the cancellation intent and period that were actually observed.                   |
| Period ends with a scheduled plan     | Apply `pendingPlan`                                  | Does not itself establish payment or extend access.                                     |
| Grace period expires                  | `past_due` → `unpaid`                                | Sync first processes outstanding paid charges. Request-time transitions do not do this. |
| Current-period chargeback             | Revoke the affected paid coverage                    | Earlier-period chargebacks are reported without undoing later coverage.                 |

`src/transitions.ts` owns clock-driven transitions. `src/billing.ts` owns payment
application and reconciliation; `src/sync.ts` coordinates catch-up. Request
handlers use `applyDueTransitions` for cancellation and scheduled plans without
prematurely expiring access while an unprocessed payment may exist.

## Invariants to preserve when changing code

- An absent lease is `NULL`, not the Unix epoch (which MySQL TIMESTAMP rejects).
  Existing expired timestamps remain claimable.
- Serialize decisions on one subscription with its database lease. Re-read
  after acquiring it, and guard writes with the lease token and expiry.
- Identity locking prevents two pending subscriptions from both activating.
- Fence immediately before an external mutation, including inside journal
  execution. A check before asynchronous journal work is insufficient.
- Journal external mutations before sending them. Lost responses must recover
  the original operation, not silently create a fresh charge.
- Apply a payment only once. Its stored purpose also governs replay, checkout
  reuse, refunds and hook payloads.
- Reconciliation must settle existing charges before deciding what Mollie
  should bill next. Keep that ordering when separating modules.
- A local payment status moves forward. A replayed old payment cannot extend
  its coverage to a newer period or revive a canceled subscription.
- An unapplied duplicate must leave durable refund work. Failed remote sync,
  refund and invoice work must remain discoverable by the next sync.
- Hooks are best effort. Access comes from the subscription and its dates,
  rather than from whether an application hook ran.

The existing operations, safety, lifecycle, outcomes, chargeback and recorded
purpose tests exercise these rules. Run the same scenarios across the database
matrix when changing guards, comparisons, unique fields, or date storage.

## Establishing operational confidence

Database tests use a stateful fake Mollie client. The real test-mode suite
covers checkout, mandate creation, recurring payment processing and cancellation;
it does not make Mollie's scheduler run on demand or prove live webhook delivery.

For a controlled rollout, retain the subscription, payment and operation records
and capture the following evidence over actual billing cycles:

1. Checkout, webhook and redirect observations converge on the same subscription.
2. Scheduled renewals advance the expected period once; repeated deliveries do
   not extend it again.
3. Failed collections preserve grace-period access, then expire or recover as
   intended. A late payment does not undo a newer cancellation.
4. Cancellation stops remote billing while preserving already-paid access.
5. Sync runs on schedule. Investigate recurring `errors`, outstanding refunds,
   missing invoices and unresolved operations, rather than counting a successful
   cron invocation as successful reconciliation.

This is an evidence checklist, not a claim that those production cycles have
already been observed. Do not delete billing records to clear an outstanding item.
