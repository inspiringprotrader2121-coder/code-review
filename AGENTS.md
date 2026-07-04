# AGENTS.md

## Project Repository
- GitHub: https://github.com/inspiringprotrader2121-coder/code-review

## Working Process
- Do server work locally first. Do not hand-edit live server files as the source of truth.
- After local changes are complete, sync them to the server with `rsync`.
- When repository work is requested, create a new branch and submit the work as a new pull request on GitHub.
- Keep server state and GitHub state aligned: local changes should be committed, pushed, opened as a PR, and then deployed/synced to the server when appropriate.

## Server Sync Rule
- Server changes must originate from this local repository.
- Use `rsync` from the local checkout to the server so the deployed files match reviewed source-controlled changes.
- Avoid making direct one-off edits on the server unless explicitly requested for an emergency hotfix; if that happens, immediately mirror the same change locally and submit it as a PR.
