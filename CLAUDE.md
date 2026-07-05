# AGENTS.md

## Project Repository
- GitHub: https://github.com/inspiringprotrader2121-coder/code-review

## Working Process
- Do server work locally first. Do not hand-edit live server files as the source of truth.
- After local changes are complete, sync them to the server with `rsync`.
- Do NOT create branches, commits, or pull requests unless explicitly asked. No small/automatic PRs — wait for an explicit request before committing or opening a PR.
- Keep server state aligned with the local checkout via `rsync`.

## Server Sync Rule
- Server changes must originate from this local repository.
- Only files that absolutely must be edited on the live server should be edited/deployed there — keep server changes to the minimum necessary.
- Use `rsync` from the local checkout to the server so the deployed files match the local source.
- Avoid making direct one-off edits on the server unless explicitly requested for an emergency hotfix; if that happens, immediately mirror the same change locally.
