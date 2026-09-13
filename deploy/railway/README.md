# Brixchat24 Railway service mapping

Keep the repository root as the source directory for every application service.
The apps share workspace packages, so setting an app folder as Railway's root
directory produces incomplete builds.

Configure each Railway service to use its matching Config-as-Code path:

| Service | Config file | Public health path |
| --- | --- | --- |
| `brixchat24-api` | `/deploy/railway/api.json` | `/health/ready` |
| `brixchat24-worker` | `/deploy/railway/worker.json` | `/` |
| `brixchat24-web` | `/deploy/railway/web.json` | `/login` |

The worker has no public application domain. Its HTTP listener exists only for
Railway deployment health checks and listens on Railway's injected `PORT`.

Provision dependencies before the application services:

1. Supabase PostgreSQL, with Data API disabled and SSL enforcement enabled.
2. Railway Redis, private-network only.
3. A ClamAV service exposing TCP `3310` on the Railway private network.
4. A private Cloudflare R2 bucket and bucket-scoped S3 credentials.
5. API, worker, then web.

Use the Supabase session pooler on port `5432` for the Railway API and worker.
Include `sslmode=require` in `DATABASE_URL`; `DATABASE_SSL=true` alone does not
change the Postgres client transport.

The web variables `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_REALTIME_URL` are build
arguments in the web Dockerfile. Set them before the first build. Never place a
database password, R2 secret, or server-side Supabase key in a `NEXT_PUBLIC_*`
variable.

Do not move custom domains to these services until all Railway-generated domain
health checks, storage checks, malware scanning, authentication, and worker
heartbeat checks pass.
