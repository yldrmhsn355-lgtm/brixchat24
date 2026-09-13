# Backup and restore

Use encrypted provider-managed PostgreSQL backups with point-in-time recovery and
separately versioned object storage. `pnpm recovery:backup-restore` rehearses a
local dump. It is not production release evidence.

For production evidence, inject `BACKUP_SOURCE_DATABASE_URL` from the deployment
secret manager, set
`PRODUCTION_BACKUP_ACCEPTANCE_CONFIRM=READ_ONLY_DUMP`, then run
`pnpm recovery:backup-restore:production`. The script takes a read-only logical
dump, restores it into a uniquely named local Docker database, verifies
organization and migration rows, records a SHA-256 checksum, and deletes the
temporary database. The release gate accepts only this production-sourced
report.

Never restore over production. Record provider backup/PITR status, RPO/RTO,
duration, row verification and operator approval separately.
