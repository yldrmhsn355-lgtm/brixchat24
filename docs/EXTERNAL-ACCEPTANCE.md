# External acceptance

Run these checks only from an authorized runner that can reach the production
private network. Copy `.env.acceptance.example` to the ignored
`.env.acceptance.local`, inject secrets from the deployment secret manager and
keep the file out of tickets, logs and Git.

Every report is bound to `ACCEPTANCE_COMMIT_SHA`, expires after 24 hours and
stores hashes instead of recipient phone numbers or provider message IDs. The
protected runner must inject the same 32-character-or-longer
`ACCEPTANCE_EVIDENCE_SIGNING_KEY` for report creation and release-gate
verification; edited or forged reports fail signature verification.
`pnpm release:gate` ignores the old `*_ACCEPTANCE_PASSED` environment flags and
requires the report files themselves.

## Meta WhatsApp

Use a consented test recipient. Sending is impossible until
`META_ACCEPTANCE_CONFIRM=SEND` is explicitly set.
When `META_WHATSAPP_ACCESS_TOKEN` and
`META_WHATSAPP_PHONE_NUMBER_ID` are omitted, the runner resolves the single
connected Meta channel from `DATABASE_URL` and decrypts its credentials in
memory with `APP_ENCRYPTION_KEY`. If multiple channels exist, set
`META_ACCEPTANCE_CHANNEL_PUBLIC_ID`. Decrypted values are never written to the
report or private state file.

1. Run `pnpm acceptance:meta:verify`.
2. Run `pnpm acceptance:meta:send-text`.
3. Run `pnpm acceptance:meta:wait-status`; it performs read-only polling for
   `delivered` or `read`.
4. Send the unique `META_ACCEPTANCE_INBOUND_MARKER` from the test phone to the
   configured WhatsApp number.
5. Run `pnpm acceptance:meta:wait-inbound`.
6. Run `pnpm acceptance:meta:report`.

Template and media sends are optional extended checks:
`acceptance:meta:send-template` and `acceptance:meta:send-media`.

## Bitrix24

Use a least-privilege webhook or OAuth access token and a dedicated test
entity.
When direct Bitrix credentials are omitted, the runner resolves the single
connected non-fake Bitrix24 record from the database and decrypts it in memory.
If multiple records exist, set `BITRIX24_ACCEPTANCE_CONNECTION_PUBLIC_ID`.

1. Run `pnpm acceptance:bitrix:health`.
2. Run `pnpm acceptance:bitrix:crm-context`.
3. Run `pnpm acceptance:bitrix:open-channels`.
4. Run `pnpm acceptance:bitrix:report`.

Timeline and assignment checks are optional mutations. They require
`BITRIX24_ACCEPTANCE_CONFIRM=MUTATE`; assignment also requires the original
responsible user and restores that user in a `finally` path.

## Infrastructure providers

- `STORAGE_ACCEPTANCE_CONFIRM=ROUNDTRIP pnpm acceptance:storage` writes,
  downloads, verifies and deletes a unique `acceptance/` object.
- `MALWARE_ACCEPTANCE_CONFIRM=EICAR pnpm acceptance:malware` requires a healthy
  ClamAV PING and detection of the standard EICAR test payload.
- `pnpm acceptance:smtp:verify` performs a connection/authentication check
  without sending mail.
- `SMTP_ACCEPTANCE_CONFIRM=SEND pnpm acceptance:smtp` verifies the SMTP
  connection and submits one message to `SMTP_ACCEPTANCE_RECIPIENT`; this
  send-backed `all` scenario is required by the final gate.

## Final gate

Generate the local/static evidence with:

1. `pnpm security:audit`
2. `pnpm security:sbom`
3. `pnpm security:licenses`
4. `pnpm security:secrets`
5. `pnpm db:migrate:check`
6. `pnpm recovery:backup-restore`
7. `pnpm load:test:smoke`

Then run `pnpm release:gate`. A pass requires valid static evidence, a
successful isolated restore, all five external reports, matching commit SHA and
unexpired evidence. Missing evidence exits `2`; invalid evidence exits `1`.
