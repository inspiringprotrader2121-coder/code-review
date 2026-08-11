import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { openSqliteConnection } from './connection.js';
import { runStoreMigrations } from './migrations.js';
import { RepositoryReadRepository } from './repositories/repository-read.js';
import { WorkspaceReadRepository } from './repositories/workspace-read.js';
import { SqliteIdentityRepository } from './repositories/identity.js';
import { SqliteTenancyRepository } from './repositories/tenancy.js';
import { SqliteReviewStateRepository } from './repositories/review-state.js';
import { SqliteReviewPublicationRepository } from './repositories/review-publication.js';
import { SqliteRepositoryWriteRepository } from './repositories/repository-write.js';
import { SqliteBillingRepository } from './repositories/billing.js';
import { SqliteMaintenanceRepository } from './repositories/maintenance.js';
import { SqliteConnectionLifecycleRepository } from './repositories/connection-lifecycle.js';
import {
  createLocalTestStoreRuntimeOptions,
  normalizeStoreRuntimeOptions,
  type StoreRuntimeOptions,
} from './runtime-options.js';
import type {
  FindingRecord,
  FindingStatus,
  GitHubInstallation,
  PrKey,
  PrReviewState,
  PrSettings,
  PullRequest,
  PullRequestState,
  Repo,
  ReviewRun,
  ReviewRunAttempt,
  ReviewRunAttemptOutcome,
  ReviewRunStatus,
  ReviewRunUsage,
  ScorecardRun,
  Session,
  StripeMeterEvent,
  StripeRevenueEvent,
  SuperadminCostAnalytics,
  StoredFinding,
  Tenant,
  TenantBilling,
  User,
  UserSecurity,
  MfaChallenge,
  PlatformCost,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSettings,
  WorkspaceStats,
} from './types.js';

export class AppDatabase {
  private db: Database.Database;
  private readonly workerId: string;
  private readonly repositoryReads: RepositoryReadRepository;
  private readonly workspaceReads: WorkspaceReadRepository;
  private readonly identity: SqliteIdentityRepository;
  private readonly tenancy: SqliteTenancyRepository;
  private readonly reviewState: SqliteReviewStateRepository;
  private readonly reviewPublications: SqliteReviewPublicationRepository;
  private readonly repositoryWrites: SqliteRepositoryWriteRepository;
  private readonly billing: SqliteBillingRepository;
  private readonly maintenance: SqliteMaintenanceRepository;
  private readonly lifecycle: SqliteConnectionLifecycleRepository;

  constructor(options: StoreRuntimeOptions);
  constructor(databasePath: string, workerId?: string);
  constructor(optionsOrPath: StoreRuntimeOptions | string, legacyWorkerId?: string) {
    const options =
      typeof optionsOrPath === 'string'
        ? createLocalTestStoreRuntimeOptions({
            databasePath: optionsOrPath,
            workerId: legacyWorkerId,
          })
        : normalizeStoreRuntimeOptions(optionsOrPath);
    // A configured worker base names a process/PM2 slot, not one lifetime of
    // that slot. Fence each boot unless the caller explicitly supplies an id.
    this.workerId = options.workerId ?? `${options.workerIdBase}:${randomUUID()}`;
    this.db = openSqliteConnection(options.databasePath, {
      checkoutRoot: options.checkoutRoot,
      requireDurableStorage: options.requireDurableStorage,
    });
    this.maintenance = new SqliteMaintenanceRepository(this.db, this.workerId);
    this.lifecycle = new SqliteConnectionLifecycleRepository(this.db);
    this.repositoryReads = new RepositoryReadRepository(this.db);
    this.workspaceReads = new WorkspaceReadRepository(this.db);
    this.identity = new SqliteIdentityRepository(this.db);
    this.tenancy = new SqliteTenancyRepository(this.db, options.defaultPlan);
    this.repositoryWrites = new SqliteRepositoryWriteRepository(this.db, {
      getRepoByGitHubId: (installationId, githubRepoId) =>
        this.repositoryReads.getByGitHubId(installationId, githubRepoId),
      getRepoByFullName: (installationId, fullName) =>
        this.repositoryReads.getByFullName(installationId, fullName),
      getWorkspaceSettings: (tenantId) => this.workspaceReads.getWorkspaceSettings(tenantId),
    });
    let billing!: SqliteBillingRepository;
    this.reviewState = new SqliteReviewStateRepository(
      this.db,
      {
        getRepoByFullName: (installationId, fullName) =>
          this.repositoryReads.getByFullName(installationId, fullName),
        getInstallation: (installationId) => this.tenancy.getInstallation(installationId),
        getWorkspaceSettings: (tenantId) => this.workspaceReads.getWorkspaceSettings(tenantId),
      },
      {
        debitOverageCredits: (tenantId, runId, amountCents, note) =>
          billing.debitOverageCredits(tenantId, runId, amountCents, note),
      },
      this.workerId,
    );
    this.reviewPublications = new SqliteReviewPublicationRepository(this.db, this.workerId);
    this.billing = billing = new SqliteBillingRepository(this.db, {
      listReviewRunUsage: (runId) => this.reviewState.listReviewRunUsage(runId),
    });
    runStoreMigrations(this.db);
    // This is a repair operation rather than a schema migration. Keep it on
    // every boot so terminal runs from an interrupted older process cannot
    // leave a provider attempt permanently marked running.
    this.maintenance.reconcileTerminalReviewRunAttempts();
  }

  /** Current prepaid overage balance in USD cents (can be 0, never negative in normal use). */
  getCreditBalanceCents(tenantId: string): number {
    return this.billing.getCreditBalanceCents(tenantId);
  }

  /**
   * Apply a Stripe Checkout top-up. Idempotent on stripe_session_id — Stripe
   * retries must not double-credit the wallet.
   */
  creditPrepaidTopUp(input: {
    tenantId: string;
    amountCents: number;
    stripeSessionId: string;
    note?: string;
  }): { applied: boolean; balanceCents: number } {
    return this.billing.creditPrepaidTopUp(input);
  }

  /**
   * Debit prepaid overage for a review run. Returns false when the balance is
   * insufficient. Unique on run_id so a second debit for the same run is a no-op success.
   */
  debitOverageCredits(
    tenantId: string,
    runId: string,
    amountCents: number,
    note?: string,
  ): boolean {
    return this.billing.debitOverageCredits(tenantId, runId, amountCents, note);
  }

  /** Net prepaid debit still held for a run (debit minus any refunds/adjustments). */
  overageDebitNetCents(runId: string): number {
    return this.billing.overageDebitNetCents(runId);
  }

  /** Refund a prepaid overage debit when the review was skipped before provider spend. */
  refundOverageCredits(runId: string, note?: string): boolean {
    return this.billing.refundOverageCredits(runId, note);
  }

  /**
   * After delivery, reduce a reserved deep (2×) debit to the units actually
   * delivered. Idempotent via kind=overage_partial_refund uniqueness per run.
   */
  reconcileOverageDebit(runId: string, correctDebitCents: number, note?: string): boolean {
    return this.billing.reconcileOverageDebit(runId, correctDebitCents, note);
  }

  /**
   * Claw back unused prepaid credits after a Stripe charge refund/dispute.
   * Idempotent on stripe_session_id (pass `refund:${eventId}` / `dispute:${id}`).
   * Never drives the wallet below zero — only unused balance is removed.
   */
  clawbackPrepaidCredits(input: {
    tenantId: string;
    amountCents: number;
    stripeSessionId: string;
    note?: string;
  }): { applied: boolean; clawedCents: number; balanceCents: number } {
    return this.billing.clawbackPrepaidCredits(input);
  }

  /** Current plan id for a tenant (raw string; resolve via planFeatures()). */
  getTenantPlan(tenantId: string): string | null {
    return this.billing.getTenantPlan(tenantId);
  }

  /** Set a tenant's plan (billing/admin). Returns false if the tenant is unknown. */
  setTenantPlan(tenantId: string, plan: string): boolean {
    return this.billing.setTenantPlan(tenantId, plan);
  }

  getTenantBilling(tenantId: string): TenantBilling | null {
    return this.billing.getTenantBilling(tenantId);
  }

  setTenantBilling(tenantId: string, patch: TenantBilling): boolean {
    return this.billing.setTenantBilling(tenantId, patch);
  }

  /**
   * Count reviews for a GitHub account (repo owner), for enforcing the free-trial
   * lifetime cap and hourly rate limit. Anchored to `owner` (globally unique per
   * GitHub account, matched case-insensitively) rather than the tenant, so a
   * second workspace or a reinstall can't reset the trial.
   *
   * Counts 'running', 'completed', AND 'failed' so that concurrently in-flight
   * reviews see each other AND a post-spend failure cannot refund a trial/hourly
   * credit (farmers used to induce failures after LLM burn to reset the cap).
   * A 'skipped' run is NOT counted (blocked before work / no LLM). `fix:*` /
   * `cmd:%` runs are excluded; only reviews count.
   */
  countAccountReviews(owner: string, opts: { sinceMs?: number } = {}): number {
    return this.billing.countAccountReviews(owner, opts);
  }

  countRunningAccountReviews(owner: string, sinceMs = 30 * 24 * 3_600_000): number {
    return this.billing.countRunningAccountReviews(owner, sinceMs);
  }

  /**
   * In-flight rows that reserve COGS headroom — includes scans and interactive
   * commands so a stampede cannot under-reserve the monthly dollar ceiling.
   */
  countRunningCogsReservations(owner: string, sinceMs = 30 * 24 * 3_600_000): number {
    return this.billing.countRunningCogsReservations(owner, sinceMs);
  }

  /**
   * Tenant-scoped review UNITS in the rolling window (deep=2, normal=1), same
   * status filter as countAccountReviews. Used for paid included/hard/prepaid
   * gates so wallets are not drained by another workspace's owner history.
   */
  countTenantReviewUnits(
    tenantId: string,
    opts: { sinceMs?: number; sinceIso?: string } = {},
  ): number {
    return this.billing.countTenantReviewUnits(tenantId, opts);
  }

  /**
   * Oldest `created_at` among account reviews in the rolling window — used to
   * tell users when the next hourly slot frees (that review ages out of the
   * window). Same filter as `countAccountReviews`.
   */
  oldestAccountReviewCreatedAt(owner: string, sinceMs: number): string | null {
    return this.billing.oldestAccountReviewCreatedAt(owner, sinceMs);
  }

  countTenantCompletedReviewsSince(tenantId: string, sinceIso: string): number {
    return this.billing.countTenantCompletedReviewsSince(tenantId, sinceIso);
  }

  /**
   * Quota/overage UNITS consumed since `sinceIso` — a deep review (`@orvex
   * deep`) counts as 2 units, a normal review as 1. Deep measured at ~1.8-2.25x
   * a normal review's cost, so 2 is the cost-honest weight: 2 included-quota
   * units per deep review, and 2x the per-review overage price once over quota
   * (Starter deep = $1.00, Verify deep = $1.50). Same review filter as the plain
   * count (excludes fix/cmd runs).
   */
  completedReviewUnitsSince(tenantId: string, sinceIso: string): number {
    return this.billing.completedReviewUnitsSince(tenantId, sinceIso);
  }

  /**
   * Return the quota units before and through one completed run in a stable
   * order. Billing must not derive a run's overage from the current total:
   * concurrent completions would otherwise each observe the same total and
   * double-count the boundary units. Creation time plus the UUID tie-breaker
   * makes the per-run allocation deterministic regardless of report order.
   */
  reviewRunOverageUnits(
    tenantId: string,
    runId: string,
    sinceIso: string,
  ): { unitsBefore: number; unitsThrough: number } | null {
    return this.billing.reviewRunOverageUnits(tenantId, runId, sinceIso);
  }

  /**
   * Count interactive `@orvex` commands (explain/ask/resolve, recorded as
   * 'cmd:%') for an account within `sinceMs`. These are paid-only LLM calls that
   * are NOT reviews, so they get their own generous hourly ceiling — the fix for
   * the "unmetered explain/ask lets a flat-fee account run unbounded LLM spend"
   * hole. Owner-scoped, case-insensitive (same anti-farming anchor as reviews).
   */
  countAccountCommandRuns(owner: string, sinceMs = 3_600_000): number {
    return this.billing.countAccountCommandRuns(owner, sinceMs);
  }

  /**
   * Seconds since a COMPLETED review of this exact commit (installation+PR+SHA),
   * or null if there isn't one. Used to cool down repeated command/manual
   * re-review requests on an unchanged commit — a new push always gets a fresh
   * SHA and is never affected by this. This is the direct fix for a real
   * incident: with no cooldown, a human (or a script) re-issuing `@orvex review`
   * / `POST /review` on the same commit runs the full expensive review again
   * every time, with nothing to stop it — inflating both cost and any usage
   * numbers derived from review_runs.
   */
  secondsSinceLastCompletedReview(
    installationId: number,
    owner: string,
    repo: string,
    pr: number,
    headSha: string,
  ): number | null {
    return this.billing.secondsSinceLastCompletedReview(installationId, owner, repo, pr, headSha);
  }

  /** Log an onboarding event (a GitHub account connecting, a login) with the
   *  client IP, for abuse analysis. Best-effort — never throws into the flow. */
  recordAbuseSignal(input: {
    ip?: string | null;
    accountLogin?: string | null;
    tenantSlug?: string | null;
    kind: 'install' | 'login';
  }): void {
    return this.maintenance.recordAbuseSignal(input);
  }

  /** How many DISTINCT GitHub accounts have connected from this IP recently —
   *  the core "one machine farming many free trials" signal. */
  countDistinctAccountsFromIp(ip: string, sinceMs: number): number {
    return this.maintenance.countDistinctAccountsFromIp(ip, sinceMs);
  }

  /**
   * Claim a webhook delivery atomically across workers. A processed delivery is
   * permanent until retention; an unfinished claim may be reclaimed after the
   * stale window when a process died mid-handler.
   */
  claimWebhookEvent(provider: string, eventId: string, staleMs = 15 * 60_000): string | null {
    return this.maintenance.claimWebhookEvent(provider, eventId, staleMs);
  }

  getWebhookEvent(
    provider: string,
    eventId: string,
  ): { claimedAt: string; processedAt?: string } | null {
    return this.maintenance.getWebhookEvent(provider, eventId);
  }

  completeWebhookEvent(provider: string, eventId: string, claimToken: string): void {
    return this.maintenance.completeWebhookEvent(provider, eventId, claimToken);
  }

  releaseWebhookEvent(provider: string, eventId: string, claimToken: string): void {
    return this.maintenance.releaseWebhookEvent(provider, eventId, claimToken);
  }

  /**
   * Content-hash claim for webhook replay defense. GitHub retries reuse the same
   * X-GitHub-Delivery; an attacker who captured a valid signed body can rotate
   * the delivery id. Claiming sha256(event + body) under `${provider}-body`
   * closes that gap.
   *
   * Processed body hashes EXPIRE after `ttlMs` (default 2h) so identical tiny
   * payloads (e.g. ping `{}`) are not blocked forever — unlike delivery ids,
   * which stay claimed until long retention.
   */
  claimWebhookBodyHash(
    provider: string,
    bodyHash: string,
    opts: { ttlMs?: number; staleMs?: number } = {},
  ): string | null {
    return this.maintenance.claimWebhookBodyHash(provider, bodyHash, opts);
  }

  /** Provider key used by claimWebhookBodyHash for lookups/complete/release. */
  webhookBodyProvider(provider: string): string {
    return this.maintenance.webhookBodyProvider(provider);
  }

  /** Cheap liveness probe for /ready — throws if the DB is unreachable/locked. */
  pingDb(): void {
    return this.maintenance.pingDb();
  }

  /** Clear only rows whose durable heartbeat is stale. A second worker process
   * must never interrupt a peer's live review during a rolling start. */
  failStaleRunningRuns(opts: { staleAfterMs?: number; nowMs?: number } = {}): number {
    return this.maintenance.failStaleRunningRuns(opts);
  }

  heartbeatReviewRun(id: string): boolean {
    return this.maintenance.heartbeatReviewRun(id);
  }

  claimReviewPublication(
    input: import('./repositories/review-publication.js').ReviewPublicationScope,
  ): import('./repositories/review-publication.js').ReviewPublicationClaim {
    return this.reviewPublications.claimReviewPublication(input);
  }

  completeReviewPublication(
    input: import('./repositories/review-publication.js').ReviewPublicationScope & {
      claimToken: string;
      resultJson: string | null;
    },
  ): boolean {
    return this.reviewPublications.completeReviewPublication(input);
  }

  releaseReviewPublication(
    input: import('./repositories/review-publication.js').ReviewPublicationScope & {
      claimToken: string;
    },
  ): boolean {
    return this.reviewPublications.releaseReviewPublication(input);
  }

  listAbandonedReviewPublications(
    abandonedBefore: string,
    limit?: number,
  ): import('./repositories/review-publication.js').AbandonedReviewPublication[] {
    return this.reviewPublications.listAbandonedReviewPublications(abandonedBefore, limit);
  }

  resolveAbandonedReviewPublication(
    input: import('./repositories/review-publication.js').ResolveReviewPublicationInput,
  ): boolean {
    return this.reviewPublications.resolveAbandonedReviewPublication(input);
  }

  listReviewPublicationResolutions(
    limit?: number,
  ): import('./repositories/review-publication.js').ReviewPublicationResolution[] {
    return this.reviewPublications.listReviewPublicationResolutions(limit);
  }

  /**
   * Atomically mark a still-running review as interrupted. Automatic shutdown
   * does not replay paid stages; an explicit recovery may still reopen the same
   * row via resumeReviewRun without consuming another quota slot.
   */
  interruptReviewRun(id: string): boolean {
    return this.maintenance.interruptReviewRun(id);
  }

  /**
   * Bounded retention. Deletes only EPHEMERAL rows — never 'completed' or
   * 'failed' reviews. Lifetime trial counts running+completed+failed forever
   * (anti-farm); pruning `failed` after 30d refunded the trial. Only `skipped`
   * cooldown/limit/misfire rows are ephemeral. Also clears expired sessions and
   * old abuse signals. Safe to run on a schedule.
   */
  pruneEphemeralData(opts: { runRetentionMs?: number; abuseRetentionMs?: number } = {}): number {
    return this.maintenance.pruneEphemeralData(opts);
  }

  // ——— Tenants ———

  createTenant(slug: string, name?: string): Tenant {
    return this.tenancy.createTenant(slug, name);
  }

  getTenantBySlug(slug: string): Tenant | null {
    return this.tenancy.getTenantBySlug(slug);
  }

  getOrCreateTenant(slug: string, name?: string): Tenant {
    return this.tenancy.getOrCreateTenant(slug, name);
  }

  /**
   * Slug of the most "active" tenant for the legacy dashboard's default view:
   * the one with the most tracked repos, then the one with a live installation,
   * then the earliest created. Avoids landing on an empty demo workspace.
   */
  firstTenantSlug(): string | null {
    return this.tenancy.firstTenantSlug();
  }

  getTenantById(id: string): Tenant | null {
    return this.tenancy.getTenantById(id);
  }

  getTenantByStripeCustomerId(customerId: string): Tenant | null {
    return this.tenancy.getTenantByStripeCustomerId(customerId);
  }

  listStripeCustomers(): Array<{ tenantId: string; customerId: string }> {
    return this.tenancy.listStripeCustomers();
  }

  // ——— Installations ———

  upsertInstallation(input: {
    installationId: number;
    tenantId: string;
    accountLogin: string;
    accountType: string;
    repositorySelection?: string;
    suspendedAt?: string | null;
  }): GitHubInstallation {
    return this.tenancy.upsertInstallation(input);
  }

  getInstallation(installationId: number): GitHubInstallation | null {
    return this.tenancy.getInstallation(installationId);
  }

  getInstallationsForTenant(tenantId: string): GitHubInstallation[] {
    return this.tenancy.getInstallationsForTenant(tenantId);
  }

  findInstallationForRepo(owner: string, repo: string): GitHubInstallation | null {
    return this.tenancy.findInstallationForRepo(owner, repo);
  }

  // ——— PR review state ———

  getState(key: PrKey): PrReviewState | null {
    return this.reviewState.getState(key);
  }

  saveState(state: PrReviewState): void {
    return this.reviewState.saveState(state);
  }

  // ——— Users & sessions ———

  upsertUserFromGitHub(input: {
    githubId: number;
    login: string;
    name?: string | null;
    avatarUrl?: string | null;
    email?: string | null;
    normalizedEmail?: string;
  }): User {
    return this.identity.upsertUserFromGitHub(input);
  }

  /** Set normalized_email when it's currently missing (backfills existing accounts
   *  on their next login without touching the delicate OAuth-link branches). */
  setUserNormalizedEmailIfMissing(userId: string, normalizedEmail: string): void {
    return this.identity.setUserNormalizedEmailIfMissing(userId, normalizedEmail);
  }

  getUserByGitHubId(githubId: number): User | null {
    return this.identity.getUserByGitHubId(githubId);
  }

  upsertUserFromGoogle(input: {
    googleId: string;
    email: string;
    name?: string | null;
    avatarUrl?: string | null;
    normalizedEmail?: string;
  }): User {
    return this.identity.upsertUserFromGoogle(input);
  }

  getUserByGoogleId(googleId: string): User | null {
    return this.identity.getUserByGoogleId(googleId);
  }

  getUserById(id: string): User | null {
    return this.identity.getUserById(id);
  }

  // ——— Email/password auth ———

  /** Create (or update the password of) an email/password user. */
  upsertPasswordUser(input: {
    email: string;
    passwordHash: string;
    name?: string;
    login?: string;
  }): User {
    return this.identity.upsertPasswordUser(input);
  }

  /** Create a password account without ever changing an existing account. */
  createPasswordUser(input: {
    email: string;
    passwordHash: string;
    name?: string;
    login?: string;
    /** alias-collapsed identity (caller computes via tenants.normalizeEmail) */
    normalizedEmail?: string;
  }): User | null {
    return this.identity.createPasswordUser(input);
  }

  /** Mark a password email verified after a future email-verification flow. */
  setUserEmailVerified(userId: string, verifiedAt = new Date().toISOString()): boolean {
    return this.identity.setUserEmailVerified(userId, verifiedAt);
  }

  getUserByEmail(email: string): User | null {
    return this.identity.getUserByEmail(email);
  }

  /** Any existing account whose normalized (alias-collapsed) email matches — the
   *  anchor for email-alias anti-farming. Caller passes a value from
   *  tenants.normalizeEmail. Returns the first match (accounts are deduped at
   *  signup, so there should be at most one). */
  getUserByNormalizedEmail(normalizedEmail: string): User | null {
    return this.identity.getUserByNormalizedEmail(normalizedEmail);
  }

  getPasswordHash(userId: string): string | null {
    return this.identity.getPasswordHash(userId);
  }

  setUserSuperAdmin(userId: string, enabled: boolean): boolean {
    return this.identity.setUserSuperAdmin(userId, enabled);
  }

  getUserSecurity(userId: string): UserSecurity {
    return this.identity.getUserSecurity(userId);
  }

  setPendingTotpSecret(userId: string, encryptedSecret: string): boolean {
    return this.identity.setPendingTotpSecret(userId, encryptedSecret);
  }

  enableTotp(userId: string, recoveryCodeHashes: string[]): boolean {
    return this.identity.enableTotp(userId, recoveryCodeHashes);
  }

  completeTotpEnrollment(input: {
    userId: string;
    expectedEncryptedSecret: string;
    totpEpoch: number;
    recoveryCodeHashes: string[];
    sessionTtlMs?: number;
  }): Session | null {
    return this.identity.completeTotpEnrollment(input);
  }

  disableTotpAndRotateSession(input: {
    userId: string;
    factor: { totpEpoch: number } | { recoveryCodeHash: string };
    sessionTtlMs?: number;
  }): Session | null {
    return this.identity.disableTotpAndRotateSession(input);
  }

  regenerateRecoveryCodesAndRotateSession(input: {
    userId: string;
    totpEpoch: number;
    recoveryCodeHashes: string[];
    sessionTtlMs?: number;
  }): Session | null {
    return this.identity.regenerateRecoveryCodesAndRotateSession(input);
  }

  disableTotp(userId: string): void {
    return this.identity.disableTotp(userId);
  }

  consumeRecoveryCode(userId: string, codeHash: string): boolean {
    return this.identity.consumeRecoveryCode(userId, codeHash);
  }

  acceptTotpEpoch(userId: string, epoch: number): boolean {
    return this.identity.acceptTotpEpoch(userId, epoch);
  }

  consumeAuthAttempt(
    rateKey: string,
    opts: { windowMs: number; max: number },
    now = Date.now(),
  ): { allowed: boolean; retryAfterSeconds: number } {
    return this.identity.consumeAuthAttempt(rateKey, opts, now);
  }

  clearAuthAttempts(rateKey: string): void {
    return this.identity.clearAuthAttempts(rateKey);
  }

  consumeMfaAttempt(
    userId: string,
    opts: { windowMs: number; max: number },
    now = Date.now(),
  ): { allowed: boolean; retryAfterSeconds: number } {
    return this.identity.consumeMfaAttempt(userId, opts, now);
  }

  clearMfaAttempts(userId: string): void {
    return this.identity.clearMfaAttempts(userId);
  }

  createMfaChallenge(userId: string, next: string, ttlMs = 5 * 60_000): MfaChallenge {
    return this.identity.createMfaChallenge(userId, next, ttlMs);
  }

  getMfaChallenge(id: string): MfaChallenge | null {
    return this.identity.getMfaChallenge(id);
  }

  consumeMfaChallenge(id: string): MfaChallenge | null {
    return this.identity.consumeMfaChallenge(id);
  }

  completeMfaChallenge(
    challengeId: string,
    factor: { totpEpoch: number } | { recoveryCodeHash: string },
    sessionTtlMs = 30 * 24 * 3_600_000,
  ): { challenge: MfaChallenge; session: Session } | null {
    return this.identity.completeMfaChallenge(challengeId, factor, sessionTtlMs);
  }

  deleteMfaChallenge(id: string): void {
    return this.identity.deleteMfaChallenge(id);
  }

  deleteMfaChallengesForUser(userId: string): void {
    return this.identity.deleteMfaChallengesForUser(userId);
  }

  /** True if any email/password account exists — used to require login. */
  hasPasswordUsers(): boolean {
    return this.identity.hasPasswordUsers();
  }

  createSession(userId: string, ttlMs = 30 * 24 * 3_600_000): Session {
    return this.identity.createSession(userId, ttlMs);
  }

  getSessionUser(sessionId: string): User | null {
    return this.identity.getSessionUser(sessionId);
  }

  deleteSession(sessionId: string): void {
    return this.identity.deleteSession(sessionId);
  }

  deleteSessionsForUser(userId: string): number {
    return this.identity.deleteSessionsForUser(userId);
  }

  // ——— Workspace membership ———

  addWorkspaceMember(tenantId: string, userId: string, role: WorkspaceRole): WorkspaceMember {
    return this.tenancy.addWorkspaceMember(tenantId, userId, role);
  }

  getMembership(tenantId: string, userId: string): WorkspaceMember | null {
    return this.tenancy.getMembership(tenantId, userId);
  }

  getWorkspacesForUser(userId: string): Array<{ tenant: Tenant; role: WorkspaceRole }> {
    return this.tenancy.getWorkspacesForUser(userId);
  }

  /** True if the tenant has no members yet (pre-auth workspace or freshly created). */
  /**
   * Is this workspace safe for any signed-in user to CLAIM by slug?
   *
   * Only when it has no members AND owns no GitHub installation. A tenant
   * auto-created by `syncInstallationFromWebhook` has zero members but DOES own
   * a live installation plus its repos, PRs and findings — treating "no
   * members" alone as claimable let anyone take over another org's workspace by
   * guessing the predictable `org-<login>` slug, gaining read access to private
   * findings and (via autoApply) write access to their repos.
   *
   * Claiming a workspace that owns an installation requires proving control of
   * the GitHub org, which only the signed install callback can establish.
   */
  tenantIsClaimable(tenantId: string): boolean {
    return this.tenancy.tenantIsClaimable(tenantId);
  }

  tenantHasMembers(tenantId: string): boolean {
    return this.tenancy.tenantHasMembers(tenantId);
  }

  // ——— PR settings (auto-apply) ———

  getPrSettings(key: PrKey): PrSettings {
    return this.reviewState.getPrSettings(key);
  }

  setPrAutoApply(key: PrKey, enabled: boolean): void {
    return this.reviewState.setPrAutoApply(key, enabled);
  }

  // ——— Fix locks (one fix operation per PR at a time) ———

  acquireFixLock(key: PrKey, holder: string, staleMs = 300_000): boolean {
    return this.reviewState.acquireFixLock(key, holder, staleMs);
  }

  releaseFixLock(key: PrKey, holder: string): void {
    return this.reviewState.releaseFixLock(key, holder);
  }

  // ——— Finding suppressions (@orvex ignore) ———

  addSuppression(input: {
    installationId: number;
    owner: string;
    repo: string;
    fingerprint: string;
    ruleId?: string;
    suppressedBy?: string;
  }): void {
    return this.reviewState.addSuppression(input);
  }

  getSuppressedFingerprints(installationId: number, owner: string, repo: string): Set<string> {
    return this.reviewState.getSuppressedFingerprints(installationId, owner, repo);
  }

  /** Fix commits on this PR in the last `sinceMs` — the runaway-loop guard. */
  countRecentFixRuns(key: PrKey, sinceMs = 86_400_000): number {
    return this.reviewState.countRecentFixRuns(key, sinceMs);
  }

  /** Skipped runs for this PR with a given reason in the last `sinceMs` (nudge dedupe). */
  countRecentSkippedRuns(key: PrKey, skipReason: string, sinceMs: number): number {
    return this.reviewState.countRecentSkippedRuns(key, skipReason, sinceMs);
  }

  /** Failed review attempts for this PR in the last `sinceMs` (failure notice dedupe). */
  countRecentFailedRuns(key: PrKey, sinceMs = 30 * 60_000): number {
    return this.reviewState.countRecentFailedRuns(key, sinceMs);
  }

  // ——— Review runs (usage metrics) ———

  recordReviewRun(input: {
    tenantId: string;
    installationId: number;
    owner: string;
    repo: string;
    pr: number;
    headSha: string;
    action: string;
    status: ReviewRunStatus;
    skipReason?: string;
    error?: string;
    durationMs: number;
    findingsNew?: number;
    findingsFixed?: number;
    findingsOpen?: number;
    /** `@orvex deep` run — weighted as 2 quota/overage units. Defaults to 0. */
    deep?: boolean;
    /** run started under a trial/free plan — feeds the global free-tier cap. */
    freeTier?: boolean;
    /** Test seam only — backdate the row to exercise time-windowed limit checks
     *  (e.g. reviewsPerMonth vs reviewsPerHour) without waiting real time.
     *  Production code never passes this; it always defaults to now. */
    createdAt?: string;
  }): ReviewRun {
    return this.reviewState.recordReviewRun(input);
  }

  /**
   * Insert a 'running' row the moment a job starts, so the dashboard shows the
   * run immediately instead of only after it finishes. Returns the row id to
   * pass to completeReviewRun when the job ends.
   */
  startReviewRun(input: {
    tenantId: string;
    installationId: number;
    owner: string;
    repo: string;
    pr: number;
    headSha: string;
    action: string;
    /** true for `@orvex deep` runs — drives the deep-vs-normal scorecard */
    deep?: boolean;
    /** true when this run is on a trial/free plan — powers the global daily cap */
    freeTier?: boolean;
  }): string {
    return this.reviewState.startReviewRun(input);
  }

  /**
   * Check account limits and reserve a `running` row in one BEGIN IMMEDIATE
   * transaction so multi-worker processes sharing this SQLite file cannot both
   * read under-limit and both insert.
   */
  tryReserveReviewRun(
    input: {
      tenantId: string;
      installationId: number;
      owner: string;
      repo: string;
      pr: number;
      headSha: string;
      action: string;
      deep?: boolean;
      freeTier?: boolean;
      /** @deprecated Prefer computeOverageDebit so the amount is read inside the txn. */
      overageDebitCents?: number;
      /**
       * Compute prepaid debit INSIDE the BEGIN IMMEDIATE transaction after
       * limitReason() passes, so concurrent workers cannot both observe
       * "still included" and skip the debit.
       */
      computeOverageDebit?: () => number;
    },
    limitReason: () => string | null,
  ): { ok: true; runId: string } | { ok: false; reason: string } {
    return this.reviewState.tryReserveReviewRun(input, limitReason);
  }

  /** Global count of free-tier reviews started across ALL accounts in the last
   *  `sinceMs` — the anchor for the free-tier daily spend circuit-breaker. Counts
   *  running + completed (a farm's in-flight reviews cost money too). */
  countGlobalFreeTierReviewsSince(sinceMs: number): number {
    return this.reviewState.countGlobalFreeTierReviewsSince(sinceMs);
  }

  /** Re-point a running review at the ACTUAL head SHA being reviewed. The run row
   *  is created from the webhook payload's headSha up front, but by the time the
   *  worker fetches the PR a newer commit may have landed — the run must be
   *  recorded on the SHA that was really reviewed (cooldown/dedup/scorecard all
   *  key on head_sha). */
  setReviewRunHeadSha(id: string, headSha: string): boolean {
    return this.reviewState.setReviewRunHeadSha(id, headSha);
  }

  /**
   * Reopen the single run row reserved before a graceful restart. Reusing the
   * row keeps an interrupted attempt from consuming a second trial/hourly slot.
   * A completed row is reported separately so a late shutdown requeue cannot
   * run the same review twice.
   */
  resumeReviewRun(
    id: string,
    input: Pick<
      Parameters<AppDatabase['startReviewRun']>[0],
      'tenantId' | 'installationId' | 'owner' | 'repo' | 'pr' | 'action'
    >,
  ): 'resumed' | 'completed' | 'unavailable' {
    return this.reviewState.resumeReviewRun(id, input);
  }

  /** Finalize a row created by startReviewRun with its terminal status + counts. */
  completeReviewRun(
    id: string,
    patch: {
      status: ReviewRunStatus;
      skipReason?: string;
      error?: string;
      durationMs: number;
      findingsNew?: number;
      findingsFixed?: number;
      findingsOpen?: number;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      /** what this run NEWLY posted — feeds the deep-vs-normal scorecard */
      newFindings?: Array<{ severity: string; file: string; line?: number }>;
      /** Correct the `deep` flag to what was actually DELIVERED. The row is
       *  created before the passes run, so a deep request whose extra lenses all
       *  failed would otherwise stay marked deep — and be counted (and billed)
       *  as 2 units by completedReviewUnitsSince. */
      deep?: boolean;
    },
  ): boolean {
    return this.reviewState.completeReviewRun(id, patch);
  }

  startReviewRunAttempt(
    input: Omit<
      ReviewRunAttempt,
      'role' | 'outcome' | 'dispatched' | 'durationMs' | 'completedAt'
    > & { role?: ReviewRunAttempt['role'] },
  ): boolean {
    return this.reviewState.startReviewRunAttempt(input);
  }

  completeReviewRunAttempt(input: {
    id: string;
    outcome: Exclude<ReviewRunAttemptOutcome, 'running'>;
    dispatched?: boolean;
    durationMs: number;
    completedAt: string;
    error?: string;
  }): boolean {
    return this.reviewState.completeReviewRunAttempt(input);
  }

  listReviewRunAttempts(runId: string): ReviewRunAttempt[] {
    return this.reviewState.listReviewRunAttempts(runId);
  }

  /** Persist one provider usage event as soon as the provider reports it. */
  recordReviewRunUsage(
    input: Omit<ReviewRunUsage, 'id' | 'createdAt'> & { createdAt?: string },
  ): ReviewRunUsage | null {
    return this.reviewState.recordReviewRunUsage(input);
  }

  listReviewRunUsage(runId: string): ReviewRunUsage[] {
    return this.reviewState.listReviewRunUsage(runId);
  }

  /** Record gross Stripe revenue once; event_id makes webhook retries harmless. */
  recordStripeRevenueEvent(
    input: Omit<StripeRevenueEvent, 'createdAt'> & { createdAt?: string },
  ): boolean {
    return this.billing.recordStripeRevenueEvent(input);
  }
  assignUnlinkedStripeRevenue(customerId: string, tenantId: string): number {
    return this.billing.assignUnlinkedStripeRevenue(customerId, tenantId);
  }
  sumStripeRefundsForCharge(chargeId: string): number {
    return this.billing.sumStripeRefundsForCharge(chargeId);
  }
  enqueueStripeMeterEvent(input: {
    runId: string;
    tenantId: string;
    customerId: string;
    eventName: string;
    plan: string;
    units: number;
  }): StripeMeterEvent {
    return this.billing.enqueueStripeMeterEvent(input);
  }
  getStripeMeterEvent(runId: string): StripeMeterEvent | null {
    return this.billing.getStripeMeterEvent(runId);
  }
  listPendingStripeMeterEvents(limit = 50): StripeMeterEvent[] {
    return this.billing.listPendingStripeMeterEvents(limit);
  }
  markStripeMeterAttempt(runId: string, error: string, nextAttemptAt: string): void {
    return this.billing.markStripeMeterAttempt(runId, error, nextAttemptAt);
  }
  setStripeMeterEventName(runId: string, eventName: string): void {
    return this.billing.setStripeMeterEventName(runId, eventName);
  }
  markStripeMeterReported(runId: string): void {
    return this.billing.markStripeMeterReported(runId);
  }
  listPlatformCosts(): PlatformCost[] {
    return this.billing.listPlatformCosts();
  }
  upsertPlatformCost(input: {
    category: string;
    amountCents: number;
    note?: string;
  }): PlatformCost {
    return this.billing.upsertPlatformCost(input);
  }
  deletePlatformCost(category: string): boolean {
    return this.billing.deletePlatformCost(category);
  }
  getSuperadminCostAnalytics(
    sinceIso: string,
    untilIso: string,
    planPricesCents: Record<string, number> = {},
    recentLimit = 100,
  ): SuperadminCostAnalytics {
    return this.billing.getSuperadminCostAnalytics(
      sinceIso,
      untilIso,
      planPricesCents,
      recentLimit,
    );
  }
  listScorecardRuns(limit = 500): ScorecardRun[] {
    return this.billing.listScorecardRuns(limit);
  }
  sumAccountCost(
    owner: string,
    sinceMs = 30 * 24 * 3_600_000,
  ): { costUsd: number; reviews: number } {
    return this.billing.sumAccountCost(owner, sinceMs);
  }
  listReviewRuns(tenantId: string, limit = 50): ReviewRun[] {
    return this.workspaceReads.listReviewRuns(tenantId, limit);
  }

  getWorkspaceStats(tenantId: string, sinceDays = 14): WorkspaceStats {
    return this.workspaceReads.getWorkspaceStats(tenantId, sinceDays);
  }

  // ——— Repos (selectable / enable-toggle) ———

  upsertRepo(input: {
    installationId: number;
    tenantId: string;
    githubRepoId: number;
    owner: string;
    name: string;
    fullName: string;
    private?: boolean;
    defaultBranch?: string;
    enabled?: boolean;
  }): Repo {
    return this.repositoryWrites.upsertRepo(input);
  }
  getRepoByGitHubId(installationId: number, githubRepoId: number): Repo | null {
    return this.repositoryReads.getByGitHubId(installationId, githubRepoId);
  }

  getRepoByFullName(installationId: number, fullName: string): Repo | null {
    return this.repositoryReads.getByFullName(installationId, fullName);
  }

  listRepos(tenantId: string): Repo[] {
    return this.repositoryReads.listForTenant(tenantId);
  }

  /** Enabled repos across ALL active installations, each tagged with its tenant's
   *  plan. The nightly-scan scheduler filters these by planFeatures(plan) so only
   *  eligible (Verify+) tenants are scanned. */
  listScanTargets(): Array<{
    installationId: number;
    tenantId: string;
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string | null;
    plan: string;
  }> {
    return this.repositoryWrites.listScanTargets();
  }
  setRepoEnabled(repoId: string, enabled: boolean): void {
    return this.repositoryWrites.setRepoEnabled(repoId, enabled);
  }
  disableRepoByGitHubId(installationId: number, githubRepoId: number): boolean {
    return this.repositoryWrites.disableRepoByGitHubId(installationId, githubRepoId);
  }
  disableReposForInstallation(installationId: number): number {
    return this.repositoryWrites.disableReposForInstallation(installationId);
  }
  updateRepoSettings(
    repoId: string,
    patch: {
      reviewMode?: 'normal' | 'strict';
      autoApply?: boolean;
      reviewOnOpen?: boolean;
      reviewOnPush?: boolean;
    },
  ): void {
    return this.repositoryWrites.updateRepoSettings(repoId, patch);
  }
  isRepoEnabled(installationId: number, fullName: string): boolean {
    return this.repositoryWrites.isRepoEnabled(installationId, fullName);
  }
  isRepoActionEnabled(installationId: number, fullName: string, action: string): boolean {
    return this.repositoryWrites.isRepoActionEnabled(installationId, fullName, action);
  }
  upsertPullRequest(input: {
    tenantId: string;
    installationId: number;
    repoFullName: string;
    number: number;
    title: string;
    author: string;
    state: PullRequestState;
    draft?: boolean;
    headSha: string;
    url?: string;
    openedAt?: string;
    closedAt?: string;
    mergedAt?: string;
  }): void {
    return this.repositoryWrites.upsertPullRequest(input);
  }
  markReviewedNow(
    installationId: number,
    repoFullName: string,
    prNumber: number,
    openFindings: number,
  ): void {
    return this.repositoryWrites.markReviewedNow(
      installationId,
      repoFullName,
      prNumber,
      openFindings,
    );
  }
  listPullRequests(
    tenantId: string,
    opts: { state?: PullRequestState; limit?: number } = {},
  ): PullRequest[] {
    return this.workspaceReads.listPullRequests(tenantId, opts);
  }

  getPullRequestCounts(tenantId: string): { open: number; merged: number; closed: number } {
    return this.workspaceReads.getPullRequestCounts(tenantId);
  }

  // ——— Findings projection (dashboard bug list) ———

  /** Replace the projected findings for one PR (called on every saveState). */
  projectFindings(
    key: { tenantId: string; installationId: number; owner: string; repo: string; pr: number },
    findings: StoredFinding[],
  ): void {
    return this.reviewState.projectFindings(key, findings);
  }

  listFindings(
    tenantId: string,
    opts: { status?: FindingStatus; repoFullName?: string; limit?: number } = {},
  ): FindingRecord[] {
    return this.workspaceReads.listFindings(tenantId, opts);
  }

  getFindingCounts(tenantId: string): {
    open: number;
    fixed: number;
    ignored: number;
    bySeverity: Record<string, number>;
  } {
    return this.workspaceReads.getFindingCounts(tenantId);
  }

  // ——— Workspace settings ———

  getWorkspaceSettings(tenantId: string): WorkspaceSettings {
    return this.workspaceReads.getWorkspaceSettings(tenantId);
  }

  updateWorkspaceSettings(
    tenantId: string,
    patch: Partial<Omit<WorkspaceSettings, 'tenantId' | 'updatedAt'>>,
  ): WorkspaceSettings {
    return this.repositoryWrites.updateWorkspaceSettings(tenantId, patch);
  }
  close(): void {
    return this.lifecycle.close();
  }
}

export function createAppDatabase(options: StoreRuntimeOptions): AppDatabase {
  return new AppDatabase(options);
}

/** @deprecated use createAppDatabase */
export function createReviewStore(options: StoreRuntimeOptions): AppDatabase {
  return createAppDatabase(options);
}

export type SqliteReviewStore = AppDatabase;
