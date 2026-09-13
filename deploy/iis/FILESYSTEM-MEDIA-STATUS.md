# LIVE — private filesystem media, 10 September 2026

Release 20260910-media is promoted. API ready=200/ready, worker health=200/ok; real storage and scanner checks pass under their NT SERVICE accounts. Login/refresh and core API checks pass. WhatsApp Web remained connected; no production campaign or outbox item was created by the tests.

Backup with a harmless disk probe passed hash verification: backups/live-media-20260910-052343/manifest.json and brixchat_live-2026-09-10T12-23-44-244Z.dump. The live probe was removed. Daily Brixchat24-Live-Backup now pauses API/worker writers, archives PostgreSQL and copies private media, verifies hashes, and restarts previously running services. This introduces a maintenance pause whose duration grows with stored data. The task identity is SYSTEM; execution under that scheduler identity and a restore drill for the new combined backup remain to be verified.

## Earlier implementation evidence

# Private filesystem media — implementation status

The explicit `filesystem` provider supports private media on this Windows server without an external storage account. The development `local` provider remains forbidden in production; production still requires ClamAV when media is enabled.

Implemented: strict object keys and Windows reserved-name rejection, ancestor symlink/junction checks, exclusive temporary writes, 25 MiB limit, fsync and atomic no-overwrite publication, partial-write cleanup, signed HTTPS downloads with bounded expiry, actual write/read/delete health probe. The root must remain outside IIS and writable only by API/worker and administrators. This single-server provider does not claim multi-node availability. An administrator capable of replacing trusted directories is outside its filesystem isolation boundary.

Provisioned directory: C:\ProgramData\Brixchat24\media. ACL: SYSTEM/Administrators full control; API/Worker modify. Web and unauthenticated OS users have no grant. ClamAV uses INSTREAM and does not need direct directory access.

Evidence: logs/filesystem-regression.log — 89 tests passed. logs/filesystem-media-verification.json — actual disk write, real ClamAV clean result, matching bytes, signed token and disk health passed. Integration package TypeScript check passed.

Not yet deployed or enabled in live API/worker. Remaining: API upload/download tenant isolation with real PostgreSQL and ClamAV, review production configuration, release build/promotion, service-account read/write validation, backup coverage, live readiness verification. Tests did not send customer messages. Full acceptance and OS reboot verification remain open.
Update: Real API upload/download with PostgreSQL RLS and ClamAV passed. Foreign-tenant upload and signed-link issuance are denied. Scanner connection failure returns 503 with no new disk file or outbox job. The test exposed and fixed a deferred-reply stream bug in database-scope.ts; streamed replies now wait for completion. 58 API/scope/media tests passed in logs/filesystem-api-regression.log. The full release build and lint passed 13/13 (0 lint errors, 5 existing warnings). Release 20260910-media is staged; promotion is currently running, not yet verified complete. Pre-release backup: brixchat_live-2026-09-10T12-17-59-718Z.dump, archive verified.
