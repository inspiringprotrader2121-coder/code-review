# AGENTS.md

## Project Repository
- GitHub: https://github.com/inspiringprotrader2121-coder/code-review

## Working Process
- Do server work locally first. Do not hand-edit live server files as the source of truth.
- After local changes are complete, deploy them with the guarded workflow in
  `scripts/deploy-safe.sh`.
- Do NOT create branches, commits, or pull requests unless explicitly asked. No small/automatic PRs — wait for an explicit request before committing or opening a PR.
- Keep server source aligned with the local checkout through that safe workflow.

## Server Sync Rule
- Do not run raw `rsync` for deploys. Use `scripts/deploy-safe.sh --dry-run`
  first, inspect the file list, then `scripts/deploy-safe.sh --restart`.
  The first rollout of the drain-aware worker may use
  `DEPLOY_BOOTSTRAP_DRAIN=1`; subsequent deploys must omit that escape hatch.
- NEVER sync `node_modules`, `dist`, `.data`, `.env`, or `*.pem` to the server.
  A full-repo sync on 2026-07-08 copied macOS-native binaries
  (better-sqlite3) onto the Linux server and crashed it on restart
  (`invalid ELF header`). The same bad sync also overwrote the runtime SQLite
  DB and removed email/password users.
- The live server DB must live outside the repo at
  `/home/orvex/orvex-data/velatrix-review.db`. Server `.env` must use that
  absolute `STORE_PATH` and stay immutable (`chattr +i`). This makes accidental
  repo syncs unable to overwrite live account data.
- Server changes must originate from this local repository.
- Only files that absolutely must be edited on the live server should be edited/deployed there — keep server changes to the minimum necessary.
- Let `scripts/deploy-safe.sh` perform its protected staged rsync so deployed
  source matches the local checkout without touching runtime state.
- Avoid making direct one-off edits on the server unless explicitly requested for an emergency hotfix; if that happens, immediately mirror the same change locally.
