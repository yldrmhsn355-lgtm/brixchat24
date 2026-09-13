# brixchat24.com IIS deployment

## LIVE — 2026-09-09

`https://brixchat24.com/` now redirects to `/login`. Public IIS routes the web
to loopback 3310 and API/webhooks to 4410. `Brixchat24-Live` supervises the
production API, worker (4110) and web. Existing local demo services are separate.
The live database is `brixchat_live`, initialized without demo customers or
channels. A single owner/platform administrator account was provisioned for
`hsnyldrm-590@hotmail.com`; access details are in the protected local file
`C:\ProgramData\Brixchat24\live\admin-access.txt`.

API and worker use separate non-superuser database logins and verified TLS.
API table ownership preserves the current repository authorization model;
complete tenant RLS enforcement still requires the repository rollout described
in `packages/database/README-tenant-role.md`. Worker has cross-tenant RLS bypass
for queue processing. Neither service receives migration credentials.

User explicitly requested that external accounts never block application
startup. Meta/Bitrix credentials are optional globally: channel/integration
credentials are configured after login, and existing signed-webhook and
authorization checks remain enforced. No fake provider is used in production.
QR runtime is enabled. No phone or Meta account has been linked by this deployment.

Email, storage and malware scanning are explicitly disabled until configured.
Email-dependent registration/recovery/invitation requests return 503 before
mutating accounts. Disabled storage rejects file operations, and the disabled
scanner never declares a file clean. Dependency health reports this as degraded;
database, Redis, login, inbox and realtime work independently. SMTP and media
service configuration remains a server setting, not a new UI editor.

Verified: HTTPS login 200 with Secure cookie, channels/conversations 200,
realtime token and SSE 200, missing-email response 503, browser root redirects
to the visible login page. Startup/disabled-adapter tests and API/worker types pass.

The sections below retain earlier rollout history; the LIVE section supersedes
the previous preparation-page status.

## Current status (2026-09-09, after Hostinger migration)

User confirmed no domain email is in use and authorized direct Hostinger/IIS
hosting. Nameservers were changed to `atlas.dns-parking.com` and
`hyperion.dns-parking.com`. Hostinger A `@` now points to `45.155.124.216`;
CNAME `www` now points to `brixchat24.com`, TTL 300. Both records verified.
Other existing Hostinger records were retained, including the old `api`
Railway CNAME; the new application uses same-origin API paths when activated.

IIS site `Brixchat24-Public` serves a temporary preparation page from
`C:\inetpub\Brixchat24-Public`. HTTPS is verified with a Let's Encrypt
certificate expiring 2026-12-08. HTTP and www redirect to
`https://brixchat24.com`. Firewall rule `Brixchat24 HTTP HTTPS` permits 80/443.
The local demo application remains on loopback 8080, not publicly exposed.

win-acme's daily task renews the certificate using SelfHosting HTTP-01.
`Brixchat24-Certificate-Sync` runs daily at 14:00 and binds the newest matching
certificate from LocalMachine/WebHosting to the two SNI bindings. Its script is
`sync-public-certificate.ps1`. Public configuration is `public-web.config`.
The application production prerequisites below are still outstanding.

Preparation continued: `.env.iis.production` is a protected, inactive draft
with the real domain URLs, secure cookies, fresh signing/operations secrets,
and private Redis settings. External service fields are intentionally empty;
setting a provider name alone does not prove connectivity. This draft must be
split into service-specific environments before use, especially DB credentials.
The requested owner email is recorded there; no production account exists yet.

`backup-database.mjs` created a custom-format database archive and verified its
table of contents with pg_restore. `Brixchat24-Database-Backup` runs daily at
03:00 using the local database configuration. Backups remain on this server
under `C:\ProgramData\Brixchat24\backups`; off-server replication and a full
restore drill remain to be configured. Graphify is unavailable on this machine.

The following inspection and plan describe the state before migration.

Target Windows server: `45.155.124.216`.
Current local application: `http://localhost:8080`.

## DNS inspection (2026-09-09)

Authoritative nameservers are `tony.ns.cloudflare.com` and
`venus.ns.cloudflare.com`. DNS changes must be made in that Cloudflare zone,
even if the domain registration is managed at Hostinger.

Observed records:

| Name | Type | Existing target | Proposed target |
| --- | --- | --- | --- |
| @ | A | 69.46.46.3 | 45.155.124.216 |
| www | CNAME | qbvz2pb1.up.railway.app | brixchat24.com |

These changes are prepared, **not applied**. Keep existing mail and verification
records. Confirm there are no conflicting AAAA records at cutover. Use DNS-only
during direct IIS certificate validation. The existing Railway destination will
stop receiving traffic after the DNS change propagates.

## Deployment prerequisites

The repository's `validateProductionConfig` currently rejects the local test
configuration. Required work includes SMTP, private S3/R2 storage, ClamAV,
real Meta and Bitrix settings, database TLS, HTTPS public URLs and secure
cookies. Scoped database users and Redis rate limits should also be configured.
Do not bypass these checks by exposing the development runtime as production.

Before opening the application publicly, provision the owner's account and
disable the seeded demo accounts; preserve the local test environment until
the new configuration has passed validation. Back up the database first.

## Cutover sequence

1. Obtain Cloudflare DNS access and required production service settings.
2. Prepare a separate production environment and validate API and worker.
3. Create domain-specific IIS bindings and an ACME validation path; keep the
   application private until credentials and production checks are ready.
4. Change the two DNS records above and issue a certificate for
   `brixchat24.com` and `www.brixchat24.com` using win-acme.
5. Configure renewal, HTTPS redirect and canonical www-to-apex redirect.
6. Verify login, API, streaming, upload scanning and worker health through HTTPS.

win-acme is staged under `C:\ProgramData\Brixchat24\win-acme`.
No certificate has been requested yet. DNS and public bindings are unchanged.
