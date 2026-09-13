# Bitrix24 setup

This document covers both (a) connecting a single Bitrix24 portal to a Brixchat24
deployment today, and (b) what's already in place — and what's still missing —
for submitting Brixchat24 as a listed app on **Bitrix24.Market**.

## How the integration works

Brixchat24 talks to Bitrix24 over two independent paths, both backed by the same
`integration_connections` table (multi-tenant: one row per organization + portal,
each with its own encrypted OAuth credentials):

1. **Manual webhook** (`POST /api/v1/integrations/bitrix24/webhook-connect`) — the
   simplest path. The customer pastes an "incoming webhook" URL/token generated
   from inside their own Bitrix24 (Applications → Webhooks). No OAuth app
   registration required on our side; good for quick testing, but the token
   doesn't auto-refresh and the customer has to regenerate it manually if it's
   revoked.
2. **OAuth "local application"** (`POST /api/v1/integrations/bitrix24/local-app/start`,
   callback at `POST /webhooks/bitrix24/install/:connectionPublicId`) — the real
   marketplace-style flow. Requires `BITRIX24_CLIENT_ID` / `BITRIX24_CLIENT_SECRET`
   to be configured (see below). Access/refresh tokens are stored encrypted per
   connection and refreshed automatically (`packages/integrations/src/crm/bitrix-client.ts`),
   with an advisory-lock guard so the API and worker processes never race to burn
   the same refresh token twice.

   A third, classic-OAuth variant exists too
   (`POST /api/v1/integrations/bitrix24/oauth/start` +
   `GET /api/v1/integrations/bitrix24/oauth/callback`), used when the local-app
   install callback isn't suitable.
3. **Bitrix24.Market "cold install"** (`POST /webhooks/bitrix24/market-install`) —
   the flow Market itself uses. Unlike the two paths above, this one is
   intentionally unauthenticated: a customer who has never touched Brixchat24
   clicks "Install" *inside their own Bitrix24*, and Bitrix24 POSTs the OAuth
   grant straight to this one fixed URL. The handler verifies the grant by
   calling back into the reported portal (`app.info`/`profile` — a forged
   `domain` can't produce a token that authenticates against a real portal),
   then provisions a brand-new organization, trial entitlement, placeholder
   owner user, and connection in one transaction. It replies with an HTML page
   (Bitrix24 loads the install URL in an iframe in the admin's browser) that
   calls `BX24.installFinish()` and links to `/bitrix24-setup?token=...`, a
   one-time link (`bitrix_setup_tokens`, 24h TTL) where the admin sets their
   real email/name/password and is logged straight in. A partial unique index
   on `integration_connections(provider, member_id)` (active connections only)
   stops the same portal from spawning more than one organization if Bitrix24
   retries the install POST or the admin double-clicks.

Once connected, `ON_APP_INSTALL` subscribes the portal to the events in
`BITRIX_CRM_EVENTS` (`apps/api/src/crm-routes.ts`): CRM contact/lead/deal/company
updates, plus `ONAPPINSTALL`/`ONAPPUNINSTALL` themselves. Events land on
`POST /webhooks/bitrix24/:connectionPublicId`, get queued in `crm_webhook_events`,
and are drained by the worker (`apps/worker/src/index.ts` → `processCrmWebhook()`).

**Uninstall is handled**: when Bitrix24 fires `ONAPPUNINSTALL` (portal admin
removes the app), the worker flips the connection to `status='disconnected'`,
clears `credentials_encrypted`/`webhook_token_hash`, and logs an `app_uninstall`
entry to `crm_sync_logs` (`CrmWorkerRepository.disconnectOnAppUninstall()`). This
matters because Bitrix24's Market moderation explicitly tests the
install → uninstall → reinstall round trip.

### Open Channels (WhatsApp ↔ Bitrix24 chat)

Separately from CRM sync, `packages/integrations/src/open-channels/index.ts`
registers Brixchat24 as an **imconnector** (`imconnector.register`) so WhatsApp
conversations can be routed into a Bitrix24 Open Line
(`imopenlines.config.*`, `imconnector.activate`, `imconnector.send.messages`,
etc.). Each Bitrix line gets its own connector binding, scoped per organization.

### CRM automation rule → outbound WhatsApp send

The reverse direction — a Bitrix24 CRM automation rule/business process
triggering an outbound WhatsApp template send, with no Open Channels involved —
is documented separately in
[BITRIX24-AUTOMATION-WEBHOOK-SETUP.md](BITRIX24-AUTOMATION-WEBHOOK-SETUP.md).

## Environment variables

| Variable | Purpose |
|---|---|
| `BITRIX24_CLIENT_ID` / `BITRIX24_CLIENT_SECRET` | OAuth app credentials, issued once per Bitrix24 application registration (see below). One pair covers every customer portal — customers never see or need their own `client_id`. |
| `APP_ENCRYPTION_KEY` | Encrypts stored access/refresh tokens and webhook secrets at rest. |
| `API_PUBLIC_URL` | Public HTTPS base URL Bitrix24 calls back into (`/webhooks/bitrix24/...`, `/api/v1/integrations/bitrix24/oauth/callback`). Must be internet-reachable before any install attempt. |

Missing credentials are a blocker, not a soft-fail: the connect endpoints return
`503 bitrix_local_app_not_configured` / `bitrix_oauth_not_configured` until all
three are set.

## Registering the application in Bitrix24

1. In the target Bitrix24 portal (or the Developer Resources section), create a
   **server-side local application**.
2. For a **staging portal you connect manually**, use the install/handler URL
   pattern `${API_PUBLIC_URL}/webhooks/bitrix24/install/:connectionPublicId`
   (local-app flow) or `${API_PUBLIC_URL}/api/v1/integrations/bitrix24/oauth/callback`
   (classic OAuth redirect URI). For **Bitrix24.Market submission**, the
   "Initial installation path" registered in the Partner panel should instead
   be the single fixed `${API_PUBLIC_URL}/webhooks/bitrix24/market-install` —
   that's the URL Bitrix24 actually calls when a customer installs from the
   Market catalog.
3. Request scopes:
   - **Required**: `crm`, `user`
   - **Optional** (needed only if Open Channels/CRM messaging is used): `imopenlines`, `im`, `imconnector`, `placement`
4. Copy the issued `client_id`/`client_secret` into `BITRIX24_CLIENT_ID` /
   `BITRIX24_CLIENT_SECRET` in the deployment secret manager.
5. Connect one staging portal first via `POST /api/v1/integrations/bitrix24/local-app/start`
   and complete the flow end to end (install, a CRM update webhook, then
   uninstall) before touching production.

## Acceptance checks

Run these and keep the reports before signing off on a production connection:

```
pnpm acceptance:bitrix:health
pnpm acceptance:bitrix:crm-context
pnpm acceptance:bitrix:timeline
pnpm acceptance:bitrix:assignment
pnpm acceptance:bitrix:open-channels
pnpm acceptance:bitrix:report
```

## Status vs. Bitrix24.Market publication requirements

What's already in place (verified against `apidocs.bitrix24.com`'s publication
requirements):

- Multi-tenant OAuth with automatic token refresh — ✅
- `imconnector.*` Open Channel integration with the correct optional scopes — ✅
- Webhook signature verification (`application_token`, timing-safe compare) and
  portal-domain checks on every inbound event — ✅
- Clean install → uninstall → credential-wipe round trip — ✅ (fixed; see
  `CrmWorkerRepository.disconnectOnAppUninstall()`)
- Cold install (unauthenticated Market install → new org/user/connection,
  verified against the reported Bitrix portal, with a one-time claim link) —
  ✅ (`POST /webhooks/bitrix24/market-install`)

Still open before submitting for moderation:

- **Cold install hasn't been exercised against a real Bitrix24 portal yet.**
  The endpoint, its `app.info`/`profile` verification, and the
  `/bitrix24-setup` claim page are implemented and type-checked, but the
  publication requirements explicitly call for testing install → uninstall →
  reinstall on a clean portal before submission — do that against this flow
  specifically, not just the manual local-app path.
- Marketplace store-page content (description, screenshots, pricing policy,
  support contact) — not started; prepared separately at submission time, not
  part of this repo.
