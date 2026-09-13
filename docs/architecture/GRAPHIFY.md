# Graphify knowledge graph

Graphify indexes the whole monorepo into a local knowledge graph under
`graphify-out/`. The graph includes application code, shared packages, SQL
migrations, infrastructure configuration, scripts, tests, and documentation.

Generated dependencies and runtime artifacts are intentionally excluded. In
particular, `node_modules`, `.next*`, `dist`, `build`, coverage, test reports,
temporary/generated files, and minified bundles must never enter the graph.

## Commands

From `C:\Users\pc\Documents\wazzup2`:

```powershell
pnpm architecture:graph:update
pnpm architecture:graph:check
pnpm architecture:database:check
pnpm architecture:check
graphify query "How does authentication reach PostgreSQL?"
graphify path "ChannelsPage" "channels"
graphify explain "registerProductRoutes"
```

Run the update command after structural code changes. The check command is the
quality gate that verifies both ignore coverage and generated graph inputs. CI
runs `pnpm architecture:check` on every pull request and push to `main`. The
combined architecture gate also prevents new direct database access from being
added to API route modules; see `DATABASE-BOUNDARIES.md`.
