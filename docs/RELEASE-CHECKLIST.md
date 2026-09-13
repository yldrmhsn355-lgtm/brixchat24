# Release checklist

- CI, unit, integration, E2E and production image builds pass.
- Configuration validation, secret scan, dependency audit, SBOM and licenses pass.
- Authorized staging OWASP, load, spike, soak, queue and chaos reports meet thresholds.
- Backup restore and forward-only migration rehearsals pass.
- Real Meta, Bitrix24, object storage, malware scanner and SMTP acceptance reports pass.
- Acceptance evidence matches the deployed `/version` commit, is less than 24 hours old and passes `pnpm release:gate`; environment pass flags are not evidence.
- TLS, DNS, alerts, SLOs, synthetic monitoring and rollback are verified.
- Product owner, security owner and operations owner approve the protected environment.
