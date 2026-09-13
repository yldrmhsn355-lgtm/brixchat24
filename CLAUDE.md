# Working-directory rules for agents (Claude Code, Codex, etc.)

## Never leave uncommitted edits sitting in this main checkout

`C:\Users\pc\Desktop\Brixchat24-LIVE` is worked on by **multiple agent sessions concurrently** (see `git worktree list` — `.worktrees/<task>` is the existing convention for isolating parallel work). Pushing to `master` **auto-deploys to Railway production** (GitHub-connected: `Brixchat24`, `brixchat24`, `valiant-miracle` worker services all redeploy on push).

This combination is dangerous: if any session runs a broad `git add -A && git commit` (or similar) while another session's edits are sitting uncommitted in this shared working tree, both sets of changes get bundled into one commit under one (usually unrelated) message, pushed, merged, and **auto-deployed** — without the second session's author reviewing that specific diff as part of that commit.

This already happened once (2026-08-06): an in-progress theme/CSS change from one session was swept into an unrelated `feat(automation): add send_message action` commit by a concurrent session and merged as PR #86, auto-deploying it.

### Rules

1. **If you expect your task to take more than a few edits, or you're not certain you're the only active session, do your work in an isolated worktree, not directly here:**
   ```
   git worktree add .worktrees/<short-task-name> -b <branch-name>
   ```
   Commit and push from there; open a PR to merge deliberately.
2. **Only edit directly in this main checkout** for quick, single-shot tasks that you will commit yourself immediately, or for read-only exploration/testing (e.g. running a dev server to verify a change before committing).
3. **Never run `git add -A` / `git add .` blindly here.** Always `git status` first and stage only the files your own task touched — a broad add will scoop up any other session's unrelated in-flight work.
4. **Before committing, check `git status` for files you don't recognize touching.** If you see unexpected modified/untracked files that aren't part of your task, stop and flag it to the user rather than committing over them.
5. Remember: **deploys do not run DB migrations automatically.** After any push to `master` that includes new migrations, run `DATABASE_URL=<prod> pnpm db:migrate` manually against the Railway Postgres instance.
