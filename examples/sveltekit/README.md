# SvelteKit example

A SvelteKit app with email/password sign-in and Mollie subscriptions. It shows subscribing (including a free trial), switching plans, cancelling, restoring, recovering a failed payment, and the sync cron. It uses Node's built-in SQLite, so there is no database to set up.

## Run

From the repository root:

```bash
pnpm install
pnpm build                      # builds better-auth-mollie, which the example imports
cd examples/sveltekit
cp .env.example .env            # add your Mollie test API key
pnpm dev
```

Open http://localhost:5173, create an account and pick a plan. In test mode, pay with card `4543 4740 0224 9996` (any future expiry date and CVC), then choose the payment's outcome on Mollie's test page.

Requires Node.js 22.13 or later, for `node:sqlite`. On the very first start, Better Auth logs a "Database schema mismatch" once, before `hooks.server.ts` creates the tables. You can ignore it.

## Webhooks

Mollie cannot call `localhost`, so the plugin sends no webhook URL and logs a warning saying so. After checkout, the success redirect syncs the first payment, and the cron syncs everything else, so you can try everything without webhooks. To receive them, for example for renewals and refunds, expose the dev server and set `MOLLIE_WEBHOOK_URL`:

```bash
ngrok http 5173
# MOLLIE_WEBHOOK_URL=https://<id>.ngrok.app/api/auth/mollie/webhook
```

## Cron

`POST /api/cron/sync` runs `syncMollieSubscriptions`. Call it hourly with the `CRON_SECRET`:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:5173/api/cron/sync
```

## Files

- `src/lib/server/auth.ts`: Better Auth with the Mollie plugin (plans, VAT, hooks)
- `src/lib/auth-client.ts`: the client with `mollieClient`
- `src/hooks.server.ts`: session handling; creates the tables on start
- `src/routes/+page.svelte`: sign-in, plans and subscription management
- `src/routes/api/cron/sync/+server.ts`: the sync endpoint
