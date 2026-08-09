# Package Ownership

Ownership is by boundary, not by individual file. Changes that cross a boundary require the listed contract checks before release.

| Area                              | Primary responsibility                                              | Required checks                                                                   |
| --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/server`                     | HTTP transport, bootstrap, worker lifecycle, dashboard integration  | route contracts, auth/CSRF, readiness, integration tests                          |
| `apps/cli`                        | operator and local review commands                                  | public API imports, command tests                                                 |
| `apps/eval`                       | reproducible offline evaluation and manual budgeted live benchmarks | corpus integrity, parser, metric partition tests                                  |
| `packages/config`                 | typed configuration, compatibility aliases, generated reference     | config-doc drift check, bootstrap tests                                           |
| `packages/review`                 | review planning, adapters, findings and verification                | plan matrix, adapter contracts, no-provider tests                                 |
| `packages/queue`                  | durable queue transitions, admission and recovery                   | memory/Redis contract, concurrency/recovery tests                                 |
| `packages/store`                  | SQLite connection, migrations, tenant-safe repositories             | migration ledger, integrity, foreign-key and repository tests                     |
| `packages/github`                 | GitHub API boundary and publication adapter                         | webhook/publication contract tests                                                |
| `packages/rules`                  | deterministic repository policy                                     | rules fixtures and parser tests                                                   |
| `packages/tenants`                | identity and workspace membership primitives                        | authorization and isolation tests                                                 |
| `scripts` and `.github/workflows` | release safety, reproducible verification, operational checks       | script tests, pinned Node/pnpm, fresh Linux CI, Redis integration, coverage trend |

The deployment owner is responsible for running the guarded workflow only after CI passes. Runtime secrets and database state are owned by operations and are never part of source synchronization.

Dependabot groups development-tooling updates weekly. Provider, authentication,
queue, HTTP, and native SQLite dependencies are intentionally excluded so each
receives a focused compatibility and release review.
