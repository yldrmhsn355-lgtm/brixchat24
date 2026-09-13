# Administrator guide

Use `tenant:create`, `tenant:assign-plan`, `tenant:disable`, `tenant:enable`, `tenant:list`, and `tenant:usage` from the repository root. Production mutations require `TENANT_OPERATION_CONFIRM=<slug>`. Review `/app/settings/production`, `/health/configuration`, worker heartbeats, queues, usage and privacy requests daily. Never paste credentials into commands, tickets or logs.
