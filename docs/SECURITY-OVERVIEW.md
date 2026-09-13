# Security overview

The release candidate uses short-lived access tokens, rotating refresh sessions, secure cookies, tenant-scoped queries, role permissions, encrypted integration credentials, signed webhook verification, rate limits, structured redaction, non-root containers and TLS at Caddy. Production configuration fails closed for unsafe provider modes, weak secrets, insecure URLs, public storage, missing scanner or unprotected metrics. External penetration and authorized staging scans remain release evidence requirements.
