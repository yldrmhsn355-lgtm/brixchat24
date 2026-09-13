# Database boundaries

Graphify shows `DatabaseClient` as a high-degree connection between API route
composition, CRM and conversation operations, milestone routes, and worker
repositories. A shared database client type is expected inside the database
package and workers. The architectural risk is direct SQL in API route modules,
where tenant isolation, auditing, and transaction rules can drift between
features.

The boundary check is a ratchet, not an endorsement of the current shape. Its
baseline records 192 direct `await sql` call sites in eight API files and three
transitional `DatabaseClient` imports. CI rejects:

- direct SQL in a new API file;
- an increase in a file's recorded count;
- a new API-layer `DatabaseClient` import.

When a query moves into `packages/database`, lower the baseline in the same
change. Never increase it to make CI pass.

## Migration order

Move one cohesive domain at a time, preserving route contracts and adding
repository tests before removing route-level SQL:

1. conversation operations;
2. CRM integration operations;
3. channel and product operations;
4. milestone automation and media operations;
5. authentication, administration, and compliance operations.

Run from the repository root:

```powershell
pnpm architecture:database:check
pnpm architecture:check
```
