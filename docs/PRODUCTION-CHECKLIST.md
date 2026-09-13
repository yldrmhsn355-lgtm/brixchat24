# Production Checklist

This checklist describes Docker VPS deployment; development Compose is not a production manifest.

## Release gate

- Use managed PostgreSQL with automated backups and PITR; verify a restore before migration. Target RPO 15 minutes and RTO 4 hours.
- Use managed Redis only for cache/pub-sub/queues; PostgreSQL and object storage remain authoritative.
- Use a private S3/R2 bucket with versioning, lifecycle rules, server-side encryption and blocked public access.
- Configure ClamAV or an approved malware scanner. Production validation must reject local storage and warn/fail on Noop scanning.
- Store JWT, encryption, Meta, Bitrix and metrics secrets in mounted secret files or an external secret manager. Rotate exposed/default values.
- Configure `app.example.com`, `api.example.com` and `webhooks.example.com` behind Cloudflare and Caddy/Nginx with TLS, HSTS and firewall allowlists.
- Allow CORS only from the app origin; enable secure cookies, trusted proxy handling and correct client-IP rate limiting.
- Apply CSP, `frame-ancestors`, Referrer-Policy and content-type protections. Permit Bitrix embedding only on explicitly reviewed routes.
- Confirm public HTTPS Meta and Bitrix callbacks, signed media expiry, log redaction, protected metrics and OTLP connectivity.
- Run migration/seed only after backup evidence; run lint, typecheck, tests, E2E and build before deploy.
- Verify PostgreSQL, Redis, object storage, API, web, message/media/CRM/automation workers and realtime health after deploy.
- Schedule quarterly restore drills and record backup age, restore duration and checksums.

## Acceptance stop rules

Do not claim real Meta, Bitrix24 Open Channels, backup or restore success without observed provider responses and evidence. Do not deploy with default JWT/encryption keys, console email, local storage, Noop scanner, public buckets or unprotected metrics.
