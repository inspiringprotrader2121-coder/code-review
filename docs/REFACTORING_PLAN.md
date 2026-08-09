# Orvex Refactoring And Upgrade Plan

Status: implementation batches complete pending final integration/release evidence.
The record below does not claim that all repository gates have passed or that
production has been deployed or reopened.

## Implementation Record (2026-08-09)

Completed and locally verified across the refactor batches:

- Production review drain confirmed with zero active jobs.
- Shared bounded worker, Codex-home, and provider concurrency policy.
- Fixed named public plans and model routing for high and lower tiers.
- Five simultaneous signed webhook jobs with distinct visible run reservations.
- Typed server bootstrap configuration and one dependency composition root.
- One shared production database instance injected into every stateful route.
- Explicit, tested startup recovery and graceful-shutdown lifecycle ordering.
- Formal CLI workspace package using public exports.
- Pipeline extraction for model routing, usage accounting, and account limits.
- Codex API-key home admission test for eight active calls and a waiting ninth.
- Release metadata in readiness plus deploy-time release matching and rollback.
- Safe production PM2 capacity profile without modifying the immutable `.env`.
- Redis integration tests use per-test namespaces and never clear a whole DB.
- Orphaned paid work is durably dead-lettered with explicit operator replay.
- Queue configuration is typed and injected from the composition root.
- Backup restore drills validate current table names, integrity, and foreign keys.
- CI enforces workspace dependency/private-import boundaries and imports every
  declared workspace export as a smoke test.
- Every workspace now has project references, compiled public output, and
  package/export checks. CI has pinned Node/pnpm, Redis, fresh-Linux, policy,
  build, and compiled-export gates.
- The refactor plan now has a signed-webhook-to-dashboard characterization and
  golden matrices for routing, entitlement, billing, publication, auth, and
  queue transitions.
- Evaluation has an immutable labelled corpus and controlled-live safeguards;
  no quality claim is made without a recorded controlled run.
- Deployment has a staged rollback procedure, release identity, operator runbook,
  ownership record, and explicit protected runtime exclusions.

Remaining release evidence (not implementation claims):

- One reviewed coverage baseline generated from a stable full suite.
- Full monorepo integration, browser/accessibility, and fresh-Linux CI evidence
  from the final committed release.
- Production deployment, readiness release-ID proof, rollback drill, and an
  explicit decision to reopen the drained review queue.

## Purpose

Make Orvex simpler to understand, safer to change, easier to test, and cheaper to
upgrade without changing customer-visible behavior by accident.

This is an incremental modernization, not a rewrite. Every phase must preserve
the existing review contract until focused tests explicitly authorize a change.

## Evidence Baseline

- About 48,000 application, package, and script lines.
- 190 TypeScript files and 86 test files.
- 93 documented environment variables and more than 150 direct runtime reads.
- Main concentration points:
  - `packages/store/src/database.ts`: 4,670 lines.
  - `apps/server/src/pipeline.ts`: 3,417 lines.
  - `packages/review/src/codex-cli.ts`: 1,469 lines.
  - `packages/review/src/llm-client.ts`: 1,267 lines.
  - `apps/server/src/autofix.ts`: 1,168 lines.
  - `apps/server/src/routes/webhook.ts`: 1,085 lines.
  - `apps/server/src/routes/billing.ts`: 1,026 lines.
- The current package graph has no package-level cycle. The package split is
  broadly sound and should be clarified rather than replaced.

## Non-Negotiable Invariants

The refactor must not silently change:

- Plan names, limits, pricing, overage behavior, or customer entitlements.
- High-tier routing: Luna, DeepSeek Flash twice, MiniMax, then Flash verification.
- Lower-tier routing: MiniMax and DeepSeek Flash, then Flash verification.
- Luna and DeepSeek maximum reasoning effort.
- Luna's pinned Codex CLI, API-key authentication, model-substitution refusal,
  repository allowlist, secret isolation, and process-group cleanup.
- Queue idempotency, per-PR exclusion, ownership-token finalization, or recovery.
- SQLite WAL storage, external production database path, or atomic money/run
  reservations.
- Stripe signature validation, webhook idempotency, credit ledger, and meter
  outbox semantics.
- Password hashing, session revocation, OAuth nonce/state binding, MFA encryption,
  MFA replay protection, CSRF protection, or tenant membership authorization.
- Existing URLs, GitHub comment/check formats, and dashboard workflows during
  extraction.
- Safe deploy exclusions for `.env`, databases, keys, PEM files, `node_modules`,
  `dist`, and `.data`.

## Target Architecture

```text
apps/server
  bootstrap/       config validation and dependency composition
  http/            Hono routes, middleware, request/response mapping
  application/     review, identity, billing, workspace use cases
  ui/              layouts, components, feature renderers, typed DTOs

packages/config
  schema, compatibility aliases, profiles, redaction, generated reference

packages/review
  domain/           findings, stages, aggregation, verification
  planning/         plan compiler and provider catalog
  execution/        stage executor and attempt observer
  providers/        Codex, Responses, compatible chat, Anthropic adapters

packages/queue
  repository/       Redis state transitions and recovery
  worker/           bounded worker pool
  admission/        provider leases and cooldowns

packages/store
  connection/       SQLite open, pragmas, transaction helpers
  migrations/       ordered immutable migrations and ledger
  repositories/     identity, tenancy, reviews, billing, webhooks, repos
  analytics/        dashboard and operator read models
  legacy/           temporary AppDatabase compatibility facade

packages/billing
  plan catalog, entitlement policy, reservation, settlement, Stripe gateway

packages/github     GitHub adapter
packages/rules      repository review configuration and deterministic rules
packages/tenants    identity primitives and workspace membership
apps/cli            formal workspace app using public application APIs
apps/eval           offline evaluation plus explicit manual live benchmarks
```

## Dependency Rules

- Routes do not create databases, read raw environment variables, execute SQL,
  decide entitlements, or call provider transports.
- Domain modules do not import Hono, Redis, SQLite, GitHub, Stripe, or `process.env`.
- Provider adapters do not import queue or store implementations.
- Packages and apps use public exports; one app never imports another app's `src`.
- Configuration is parsed once at bootstrap and injected as immutable typed data.
- New behavior goes into named services/repositories, not compatibility facades.

## Phase 0: Production Safety And Characterization

Work:

- Before a refactor batch touches production, enable the existing deploy drain
  and confirm `/ready` reports `draining: true` and `activeJobs: 0`. Keep the
  drain in place until that batch's safety gates pass; this document is not proof
  that the drain is currently enabled.
- Preserve the current test suite as characterization coverage.
- Add a production-shaped, no-provider-cost integration path:
  signed webhook -> Redis -> worker -> fake model runners -> review run -> dashboard.
- Add a five-PR burst test proving five distinct jobs become visible promptly and
  provider limits constrain calls rather than whole reviews.
- Add golden matrices for plan routing, entitlement decisions, billing settlement,
  publication decisions, auth capability checks, and queue state transitions.
- Add safe Redis test namespaces; remove broad `FLUSHDB` behavior.

Exit gate:

- Current behavior is represented by deterministic tests.
- No paid provider call is required for CI.
- During a deliberately drained maintenance window, `/ready` reports zero active
  jobs and `draining: true`.

## Phase 1: Typed Configuration And Named Review Plans

Work:

- Add one typed configuration schema with groups for core, GitHub, identity,
  storage, queue, billing, providers, review policy, sandbox, and operations.
- Preserve all existing environment names through a compatibility adapter.
- Centralize worker, Codex, and provider concurrency in one policy module.
- Replace numeric pass indexes with named `ReviewStage` values.
- Add a pure `ReviewPlanCompiler` and data-driven `ProviderCatalog`.
- Generate `.env.example` and a configuration reference from schema metadata.
- Add a check that forbids new direct production `process.env` reads.

Exit gate:

- Every plan compiles to the exact intended stages, models, transports, reasoning
  effort, required/best-effort status, and verifier.
- The configured eight API-key review slots are usable end to end.
- Old and new plan compilers match in side-by-side tests before cutover.

## Phase 2: Composition Root And Application Ports

Work:

- Create `ServerConfig` and `AppServices` in one bootstrap composition root.
- Inject services into routes, workers, schedulers, and CLI entry points.
- Define narrow ports: `ReviewRunRepository`, `BillingRepository`,
  `IdentityRepository`, `GitHubPublisher`, `ReviewQueue`, `ProviderAdmission`,
  `ModelRunner`, and `AttemptObserver`.
- Keep current implementations behind adapters to avoid behavior changes.
- Make `apps/cli` a real workspace package using a public application API.

Exit gate:

- Routes and CLI no longer import private server/store implementation files.
- Tests can construct the application without global database/config singletons.

## Phase 3: Review Pipeline Decomposition

Split the current pipeline into:

1. `AdmissionService`: provider readiness, cooldowns, quotas, reservation.
2. `ReviewPreparation`: PR snapshot, config, diff, checkout, context, cancellation.
3. `ReviewExecutor`: named stage scheduling, usage, attempts, required-stage result.
4. `FindingPipeline`: aggregation, merge, verification, filtering, anchoring.
5. `PublicationService`: review/check/comment artifact and idempotent GitHub writes.
6. `FinalizationService`: run result, settlement/refund, alerts, cleanup.

Exit gate:

- `processReviewJob` is a short coordinator.
- Review computation is testable without GitHub publication.
- Publication is idempotent and separately testable.
- No model or billing behavior changes from the golden contracts.

## Phase 4: Provider Adapter Architecture

Work:

- Implement `CodexCliRunner`, `ResponsesRunner`, `CompatibleChatRunner`, and
  `AnthropicRunner` behind one typed `ModelRunner` contract.
- Make transport explicit rather than inferred from model/base URL combinations.
- Inject provider admission, retry policy, clocks, HTTP transport, process spawner,
  and attempt observer.
- Keep retries bounded and never substitute a contracted model.
- Preserve hard/inactivity timers, cancellation, usage, and retry lineage.
- Narrow the public `@orvex-review/review` exports.

Exit gate:

- One adapter contract suite covers every transport with fake streams/processes.
- Every started attempt produces exactly one terminal attempt event.
- Provider changes require catalog/adapter changes, not pipeline conditionals.

## Phase 5: Queue State Machine And Worker Pool

Work:

- Document explicit states:
  `submitted -> ready -> claimed -> running -> succeeded|failed|cancelled|dead-lettered`.
- Hide Redis keys and Lua behind a `JobRepository` transition API.
- Replace interval pumping with a fixed number of long-lived worker loops.
- Separate provider admission from the review queue contract.
- Make global recovery leader-owned and incremental.
- Add durable dead-letter records and operator-visible replay decisions.
- Run one black-box queue contract suite against memory and Redis.

Exit gate:

- Hundreds of jobs and at least eight workers pass stress/failure-injection tests.
- Claimed jobs are visible, recoverable, and never silently dropped.
- Existing token-CAS and per-PR coalescing behavior remains intact.

## Phase 6: Store Repositories And Versioned Migrations

Work:

- Extract SQLite connection/pragmas and transaction helpers.
- Introduce immutable ordered migrations with version, timestamp, and checksum.
- Keep `AppDatabase` as a temporary delegating compatibility facade.
- Extract read/analytics repositories first, then identity/tenancy, review state,
  and billing last.
- Move business policy out of SQL repositories into application services.
- Audit production data before strengthening legacy foreign keys/checks.

Exit gate:

- Historical database fixtures migrate cleanly and pass integrity/foreign-key checks.
- Every repository API is tenant-scoped or explicitly installation-scoped.
- New methods cannot be added to `AppDatabase`.
- The compatibility facade can be retired without route/pipeline changes.

## Phase 7: Billing, Entitlements, Identity, And Security

Billing work:

- Add `PlanCatalog`, `EntitlementPolicy`, `UsageReservation`, `UsageSettlement`,
  `BillingPeriod`, `StripeGateway`, and `BillingEventProcessor`.
- Unify subscription period semantics for paid included usage and overage.
- Give plans stable revisions and SKU/meter keys; resolve secret IDs in config.
- Generate dashboard/GitHub quota presentation from one entitlement snapshot.

Identity/security work:

- Add `RequestSecurity`, `IdentityService`, `AuthorizationService`, and named
  durable rate-limit policies.
- Normalize GitHub/Google behind `OAuthProvider` adapters.
- Replace raw role checks with explicit workspace capabilities.
- Add secret-free audit events for identity and privileged mutations.

Exit gate:

- Billing reserve/settle/refund is one explicit lifecycle for every paid action.
- A completed usage unit maps to exactly one intended billing path.
- Authorization matrix, CSRF matrix, OAuth linking, MFA, session, and rate-limit
  contracts pass unchanged.

## Phase 8: HTTP, Dashboard, And UI

Work:

- Make routes transport-only and use typed view models/DTOs.
- Create shared SSR layouts, safe template helpers, design tokens, and components.
- Move inline CSS/JavaScript into external assets and typed feature modules.
- Migrate dashboard and super-admin one vertical feature at a time.
- Add keyboard-accessible tabs/switches, focus behavior, chart alternatives, and
  polite live status updates.
- Pause polling in hidden tabs and cancel superseded requests.
- Remove CSP `unsafe-inline` only after every page is migrated.

Exit gate:

- Browser, accessibility, responsive visual, CSP, escaping, and DTO contract tests pass.
- Existing URLs and customer workflows remain compatible.

## Phase 9: Build, Dependencies, Deployment, And Documentation

Work:

- Give every app/package a manifest, explicit public API, and real compiled output.
- Use TypeScript project references and run built JavaScript in production.
- Add lint, format check, package-boundary, export-smoke, Node-minimum, Linux-native,
  coverage-trend, and dependency-consistency gates.
- Centralize shared dependency versions; automate low-risk updates and isolate
  provider/auth/billing/native upgrades.
- Add immutable SHA-named releases and a safe `release.json` identifier.
- Expose the non-secret release ID in readiness and verify it after deploy.
- Split deployment into prepare, validate, drain, activate, verify, and rollback.
- Add operator runbooks, ADRs, package ownership, generated config docs, and
  documentation consistency checks.

Exit gate:

- A fresh Linux checkout can install, check, test, build, and import all exports.
- Production proves the exact deployed release ID.
- Rollback atomically activates the previous known-good release.
- Documentation and generated configuration cannot drift from code.

## Delivery Rules

- Work in small, coherent batches with focused tests.
- Do not combine behavior changes with structural moves unless unavoidable.
- Keep compatibility facades until all callers migrate and contracts pass.
- Do not delete legacy behavior based only on appearance; prove it unused first.
- No paid provider calls in automated verification.
- No production deployment until the batch is committed, pushed, dry-run inspected,
  staged Linux tests pass, and release health/version is verified. `/ready` and
  the deploy rollback gate now support a release ID; production still has to be
  deployed before that control is proven live.
- Keep the production review drain engaged until the review lifecycle, concurrency,
  provider, queue, billing, and publication gates pass.

## Completion Scorecard

- [x] Direct environment access is ratcheted to configuration/bootstrap and approved entrypoints.
- [x] Workspace private-source imports and undeclared workspace dependencies are gated.
- [x] Named review stages and the provider catalog own public plan routing.
- [x] Pipeline, provider, queue, store, billing, identity, HTTP, UI, and sandbox responsibilities are split behind tested services.
- [x] Queue transitions are explicit, observable, stress-tested, and dead-lettered.
- [x] Store uses versioned migrations and narrow tenant-safe repositories.
- [x] CI defines formatting, boundary, compiled-artifact, native-Linux, and Redis gates.
- [x] Offline evaluation is reproducible; live benchmarks are manual and budgeted.
- [x] Deployment release identity, protected runtime state, and rollback controls are documented and guarded.
- [ ] Final release evidence: full-tree formatting, reviewed coverage baseline, full integration/browser/fresh-Linux CI, and production readiness/rollback verification.
