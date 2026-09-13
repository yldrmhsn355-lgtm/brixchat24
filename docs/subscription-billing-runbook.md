# Subscription billing runbook

This module adds provider-neutral subscriptions, plan limits, add-ons, billing
transactions, and an AI-credit wallet. Paddle Billing is the first provider.
Existing organizations are migrated to `legacy_free`; deploying the code and
migration cannot charge or suspend them automatically.

## Release order

1. Back up PostgreSQL and run `pnpm db:migrate:check` to lint the new migration
   for dangerous patterns. This step only checks the SQL; it does not apply it.
2. Apply migration `0043_subscription_billing.sql` before the API release by
   running `DATABASE_URL=<prod> pnpm db:migrate` against the Railway Postgres
   instance. Deploys do not run migrations automatically — this step is manual
   and required after every push to `master` that includes this migration.
3. Deploy API and web with Paddle disabled. Confirm `/app/billing` loads and
   existing tenants show `legacy_free`.
4. In Paddle Sandbox, create plan, channel add-on, and AI-credit products and
   prices. Do not reuse production IDs in sandbox.
5. In Platform Admin > Billing, enter each Paddle Price ID, currency, billing
   interval, minor-unit amount, and (for AI credit packages only) credits per
   unit. The server derives purchased credits from this catalog; the browser
   cannot choose its own credited amount.
6. Configure the Paddle notification destination as
   `https://<api-domain>/api/v1/billing/webhooks/paddle` for subscription and
   transaction events.
7. Set the environment variables below and deploy the API again.
8. Complete the sandbox acceptance matrix before changing
   `PADDLE_ENVIRONMENT=production`.

## Environment

```text
PADDLE_API_KEY=
PADDLE_CLIENT_TOKEN=
PADDLE_WEBHOOK_SECRET=
PADDLE_ENVIRONMENT=sandbox
PADDLE_CHECKOUT_URL=https://<web-domain>/app/billing
BILLING_GRACE_DAYS=7
```

The client token is public by design. API keys and webhook secrets must remain
server-side secrets. A provider is considered configured only when all required
server settings are present.

## Required Paddle events

- `subscription.created`
- `subscription.updated`
- `subscription.activated`
- `subscription.past_due`
- `subscription.paused`
- `subscription.canceled`
- `transaction.billed`
- `transaction.completed`
- `transaction.past_due`
- `transaction.canceled`

Webhook verification uses the exact raw request body, HMAC verification, a
five-minute replay window, a unique provider event ID, and provider occurrence
time ordering. Replayed credit purchases are idempotent through the ledger key.

## Acceptance matrix

- Owner can view catalog, current plan, monthly usage, wallet, and invoices.
- Non-owner cannot access billing management APIs.
- Plan checkout opens Paddle overlay for the server-created transaction.
- Successful subscription event changes the plan and entitlements.
- Past-due status allows writes only until the configured grace deadline.
- Canceled subscriptions work until their paid period end, then block writes.
- Message, channel, member, automation, and storage limits return a stable 409
  error without creating the resource.
- AI runs use the monthly included allowance first, then debit one wallet credit
  per run. Zero balance returns HTTP 402 before model execution.
- A completed AI-credit transaction credits exactly `credits_per_unit × quantity`.
- Duplicate and out-of-order webhooks do not duplicate credits or roll state back.
- Paddle customer portal opens only after a customer/subscription reference is
  known from a verified webhook.

## Production activation boundary

Production activation requires a Paddle account owner to complete business and
domain verification, create production products/prices, approve the commercial
prices and tax settings, and provide production secrets. Those provider-side
steps are not proven by a successful code deployment or sandbox test.

## Rollback

Disable Paddle by removing the provider secrets and redeploying the API. This
closes new checkout and portal sessions while preserving billing history and
existing `legacy_free` tenants. Do not drop the additive billing tables. If a
tenant needs temporary access restoration, Platform Admin can assign a manual
plan/status with an audit record while the provider incident is investigated.
