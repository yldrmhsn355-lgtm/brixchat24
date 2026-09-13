# Operations Runbook

## Triage

1. Check `/health/live`, `/health/ready` and authenticated `/health/dependencies`.
2. Check protected `/metrics` for outbox, media, automation, CRM and Open Channels backlog/failures.
3. Correlate API, `message_flow_events`, job and worker logs by trace/correlation ID; never paste tokens or message bodies.
4. For media failures, inspect attachment/job status, MIME/signature/size/scan error, storage health and retry only safe files.
5. For automation, pause the rule, inspect run steps, correlation/depth/rate limit and use dry-run before republishing.
6. For Open Channels, keep CRM context and connector queues separate; inspect source markers before replay to avoid duplicates.
7. For retention, run dry-run first and confirm legal hold before deletion.

## Recovery

- Restore PostgreSQL to an isolated environment, verify tenant counts and referential integrity, then reconnect object storage version snapshots.
- Redis may be recreated; durable outbox/event/job tables drive replay.
- Preserve and restore the encryption key before encrypted provider credentials can be used.
- Rotate secrets after suspected exposure and invalidate provider credentials at Meta/Bitrix.
- Record incident timestamps, trace IDs, backup source, RPO/RTO result and validation queries.
