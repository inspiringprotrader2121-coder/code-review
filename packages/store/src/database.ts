import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
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
  ReviewRunStatus,
  ScorecardRun,
  Session,
  StoredFinding,
  Tenant,
  TenantBilling,
  User,
  UserSecurity,
  MfaChallenge,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSettings,
  WorkspaceStats,
} from './types.js';

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_subscription_status TEXT,
  stripe_current_period_start TEXT,
  stripe_current_period_end TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  repository_selection TEXT NOT NULL DEFAULT 'selected',
  suspended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_installations_tenant ON github_installations(tenant_id);

CREATE TABLE IF NOT EXISTS pr_reviews (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  last_sha TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  last_review_at TEXT NOT NULL,
  last_summary_comment_id INTEGER,
  codex_thread_id TEXT,
  PRIMARY KEY (installation_id, owner, repo, pr)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  email TEXT,
  google_id TEXT UNIQUE,
  password_hash TEXT,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_security (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_secret_encrypted TEXT,
  last_totp_epoch INTEGER,
  recovery_code_hashes_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expiry ON mfa_challenges(expires_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL,
  reset_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS review_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  findings_new INTEGER NOT NULL DEFAULT 0,
  findings_fixed INTEGER NOT NULL DEFAULT 0,
  findings_open INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_tenant_time ON review_runs(tenant_id, created_at);
-- Every billing check runs countAccountReviews (owner-scoped, lower(owner)) up
-- to 3× per review; this expression index keeps it off a full table scan as the
-- table grows. IF NOT EXISTS + always-run schema → created on existing DBs too.
CREATE INDEX IF NOT EXISTS idx_runs_owner_lower ON review_runs(lower(owner), status, created_at);

-- Anti-abuse signal log: one row per notable onboarding event (a GitHub account
-- connecting, a login), tagged with the client IP. Used to spot one machine
-- farming many free trials by connecting many GitHub accounts.
CREATE TABLE IF NOT EXISTS abuse_signals (
  id TEXT PRIMARY KEY,
  ip TEXT,
  account_login TEXT,
  tenant_slug TEXT,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abuse_ip_time ON abuse_signals(ip, created_at);

CREATE TABLE IF NOT EXISTS pr_settings (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  auto_apply INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, owner, repo, pr)
);

CREATE TABLE IF NOT EXISTS fix_locks (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, owner, repo, pr)
);

CREATE TABLE IF NOT EXISTS finding_suppressions (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rule_id TEXT,
  suppressed_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, owner, repo, fingerprint)
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  github_repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  review_mode TEXT NOT NULL DEFAULT 'normal',
  auto_apply INTEGER NOT NULL DEFAULT 0,
  review_on_open INTEGER NOT NULL DEFAULT 1,
  review_on_push INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, github_repo_id)
);

CREATE INDEX IF NOT EXISTS idx_repos_tenant ON repos(tenant_id);

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  draft INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT NOT NULL,
  url TEXT,
  open_findings INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  closed_at TEXT,
  merged_at TEXT,
  last_reviewed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, repo_full_name, number)
);

CREATE INDEX IF NOT EXISTS idx_pulls_tenant_state ON pull_requests(tenant_id, state);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  rule_id TEXT NOT NULL,
  github_comment_id INTEGER,
  first_seen_sha TEXT NOT NULL,
  fixed_at_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, repo_full_name, pr_number, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_findings_tenant_status ON findings(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_findings_pr ON findings(installation_id, repo_full_name, pr_number);

CREATE TABLE IF NOT EXISTS workspace_settings (
  tenant_id TEXT PRIMARY KEY,
  default_review_mode TEXT NOT NULL DEFAULT 'normal',
  auto_apply_default INTEGER NOT NULL DEFAULT 0,
  min_confidence REAL NOT NULL DEFAULT 0.6,
  max_comments INTEGER NOT NULL DEFAULT 8,
  auto_enable_new_repos INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
`;

export class AppDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_V2);
    this.migrateLegacyPrReviews();
    this.migrateUserAuthColumns();
    this.migrateUserSecurityColumns();
    this.migrateTenantPlan();
    this.migrateTenantBillingColumns();
    this.migrateRepoAutomationToggles();
    this.migrateReviewRunCostColumns();
    this.migrateCodexThreadIdColumn();
  }

  /** Add Codex CLI session id column to pr_reviews on existing DBs. */
  private migrateCodexThreadIdColumn(): void {
    const cols = this.db.prepare(`PRAGMA table_info(pr_reviews)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('codex_thread_id')) {
      this.db.exec(`ALTER TABLE pr_reviews ADD COLUMN codex_thread_id TEXT`);
    }
  }

  /** Add token/cost columns to review_runs on existing DBs (fresh DBs get them
   *  from SCHEMA_V2). Enables per-review + per-owner spend visibility. */
  private migrateReviewRunCostColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(review_runs)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('input_tokens')) {
      this.db.exec(`ALTER TABLE review_runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`);
    }
    if (!names.has('output_tokens')) {
      this.db.exec(`ALTER TABLE review_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`);
    }
    if (!names.has('cost_usd')) {
      this.db.exec(`ALTER TABLE review_runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0`);
    }
    // Deep-vs-normal scorecard columns: which runs were `@orvex deep`, and what
    // each run NEWLY posted (severity/file/line JSON). Because the A/B protocol
    // runs normal-then-deep on the same commit, a deep run's new findings are
    // exactly its marginal value over normal — these two columns make that
    // measurable instead of anecdotal.
    if (!names.has('deep')) {
      this.db.exec(`ALTER TABLE review_runs ADD COLUMN deep INTEGER NOT NULL DEFAULT 0`);
    }
    // free_tier: was this run started under a trial/free plan? Powers the global
    // free-tier daily spend circuit-breaker — a bound on total free-review cost
    // that holds regardless of how a trial-farmer evades per-account/IP checks.
    if (!names.has('free_tier')) {
      this.db.exec(`ALTER TABLE review_runs ADD COLUMN free_tier INTEGER NOT NULL DEFAULT 0`);
    }
    if (!names.has('new_findings_json')) {
      this.db.exec(`ALTER TABLE review_runs ADD COLUMN new_findings_json TEXT`);
    }
  }

  /** Add the subscription plan column to an existing tenants table.
   *  Column default is 'free' so any insert that omits the plan can never
   *  silently grant a paid tier (createTenant sets it explicitly regardless). */
  private migrateTenantPlan(): void {
    const cols = this.db.prepare(`PRAGMA table_info(tenants)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'plan')) {
      this.db.exec(`ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`);
    }
  }

  /** Stripe customer/subscription state used for Checkout and metered overage. */
  private migrateTenantBillingColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(tenants)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const col of [
      'stripe_customer_id',
      'stripe_subscription_id',
      'stripe_subscription_status',
      'stripe_current_period_start',
      'stripe_current_period_end',
    ]) {
      if (!names.has(col)) this.db.exec(`ALTER TABLE tenants ADD COLUMN ${col} TEXT`);
    }
  }

  /** Split the single `enabled` repo toggle into two: review on PR open
   *  (opened/reopened) and review on each push (synchronize) — the dashboard
   *  settings section. Both default to on (matches today's behavior for
   *  existing repos: `enabled` covered both cases at once before this). */
  private migrateRepoAutomationToggles(): void {
    const cols = this.db.prepare(`PRAGMA table_info(repos)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('review_on_open')) {
      this.db.exec(`ALTER TABLE repos ADD COLUMN review_on_open INTEGER NOT NULL DEFAULT 1`);
    }
    if (!names.has('review_on_push')) {
      this.db.exec(`ALTER TABLE repos ADD COLUMN review_on_push INTEGER NOT NULL DEFAULT 1`);
    }
  }

  /** Current plan id for a tenant (raw string; resolve via planFeatures()). */
  getTenantPlan(tenantId: string): string | null {
    const row = this.db
      .prepare(`SELECT plan FROM tenants WHERE id = ?`)
      .get(tenantId) as { plan?: string } | undefined;
    const plan = row?.plan ?? null;
    if (!plan || plan === 'free') return plan;
    // Enforce subscription status: a paid plan whose Stripe subscription is in a
    // dunning/failed state must NOT keep paid access (Luna/verify COGS) through
    // Stripe's weeks-long retry window. Only an EXPLICIT bad status downgrades —
    // a missing status (fresh checkout before the first subscription.updated
    // webhook) keeps the paid plan so we never downgrade a customer who just paid.
    const status = this.getTenantBilling(tenantId)?.stripeSubscriptionStatus;
    if (status && DOWNGRADED_SUB_STATUSES.has(status)) return 'free';
    return plan;
  }

  /** Set a tenant's plan (billing/admin). Returns false if the tenant is unknown. */
  setTenantPlan(tenantId: string, plan: string): boolean {
    const res = this.db.prepare(`UPDATE tenants SET plan = ? WHERE id = ?`).run(plan, tenantId);
    return res.changes > 0;
  }

  getTenantBilling(tenantId: string): TenantBilling | null {
    const row = this.db
      .prepare(
        `SELECT stripe_customer_id, stripe_subscription_id, stripe_subscription_status,
                stripe_current_period_start, stripe_current_period_end
         FROM tenants WHERE id = ?`,
      )
      .get(tenantId) as
      | {
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          stripe_subscription_status: string | null;
          stripe_current_period_start: string | null;
          stripe_current_period_end: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      stripeCustomerId: row.stripe_customer_id ?? undefined,
      stripeSubscriptionId: row.stripe_subscription_id ?? undefined,
      stripeSubscriptionStatus: row.stripe_subscription_status ?? undefined,
      stripeCurrentPeriodStart: row.stripe_current_period_start ?? undefined,
      stripeCurrentPeriodEnd: row.stripe_current_period_end ?? undefined,
    };
  }

  setTenantBilling(tenantId: string, patch: TenantBilling): boolean {
    const existing = this.getTenantBilling(tenantId);
    if (!existing) return false;
    const next = { ...existing, ...patch };
    const res = this.db
      .prepare(
        `UPDATE tenants
         SET stripe_customer_id = ?, stripe_subscription_id = ?, stripe_subscription_status = ?,
             stripe_current_period_start = ?, stripe_current_period_end = ?
         WHERE id = ?`,
      )
      .run(
        next.stripeCustomerId ?? null,
        next.stripeSubscriptionId ?? null,
        next.stripeSubscriptionStatus ?? null,
        next.stripeCurrentPeriodStart ?? null,
        next.stripeCurrentPeriodEnd ?? null,
        tenantId,
      );
    return res.changes > 0;
  }

  /**
   * Count reviews for a GitHub account (repo owner), for enforcing the free-trial
   * lifetime cap and hourly rate limit. Anchored to `owner` (globally unique per
   * GitHub account, matched case-insensitively) rather than the tenant, so a
   * second workspace or a reinstall can't reset the trial.
   *
   * Counts 'running' AND 'completed' so that concurrently in-flight reviews see
   * each other — this is what makes a check paired with startReviewRun reserve
   * the slot atomically and stops a concurrent-PR burst slipping past the cap. A
   * 'failed'/'skipped' run is NOT counted, so a failed or blocked attempt never
   * burns a credit. `fix:*` runs are excluded; only reviews count.
   */
  countAccountReviews(owner: string, opts: { sinceMs?: number } = {}): number {
    const params: unknown[] = [owner];
    // Exclude fix commits ('fix:%') AND interactive commands ('cmd:%') — only
    // actual reviews count toward the trial/hourly/monthly review caps.
    let where =
      "lower(owner) = lower(?) AND status IN ('running', 'completed') AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%'";
    if (opts.sinceMs !== undefined) {
      where += ' AND created_at >= ?';
      params.push(new Date(Date.now() - opts.sinceMs).toISOString());
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM review_runs WHERE ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  countTenantCompletedReviewsSince(tenantId: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE tenant_id = ? AND status = 'completed'
           AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%'
           AND created_at >= ?`,
      )
      .get(tenantId, sinceIso) as { n: number };
    return row.n;
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
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN deep = 1 THEN 2 ELSE 1 END), 0) AS n FROM review_runs
         WHERE tenant_id = ? AND status = 'completed'
           AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%'
           AND created_at >= ?`,
      )
      .get(tenantId, sinceIso) as { n: number };
    return row.n;
  }

  /**
   * Count interactive `@orvex` commands (explain/ask/resolve, recorded as
   * 'cmd:%') for an account within `sinceMs`. These are paid-only LLM calls that
   * are NOT reviews, so they get their own generous hourly ceiling — the fix for
   * the "unmetered explain/ask lets a flat-fee account run unbounded LLM spend"
   * hole. Owner-scoped, case-insensitive (same anti-farming anchor as reviews).
   */
  countAccountCommandRuns(owner: string, sinceMs = 3_600_000): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE lower(owner) = lower(?) AND action LIKE 'cmd:%'
           AND status IN ('running', 'completed') AND created_at >= ?`,
      )
      .get(owner, since) as { n: number };
    return row.n;
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
    const row = this.db
      .prepare(
        `SELECT created_at FROM review_runs
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ? AND head_sha = ?
           AND status = 'completed' AND action NOT LIKE 'fix:%'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(installationId, owner, repo, pr, headSha) as { created_at: string } | undefined;
    if (!row) return null;
    return Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000);
  }

  /** Log an onboarding event (a GitHub account connecting, a login) with the
   *  client IP, for abuse analysis. Best-effort — never throws into the flow. */
  recordAbuseSignal(input: {
    ip?: string | null;
    accountLogin?: string | null;
    tenantSlug?: string | null;
    kind: 'install' | 'login';
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO abuse_signals (id, ip, account_login, tenant_slug, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.ip ?? null,
          input.accountLogin ?? null,
          input.tenantSlug ?? null,
          input.kind,
          new Date().toISOString(),
        );
    } catch {
      /* signal logging must never break onboarding */
    }
  }

  /** How many DISTINCT GitHub accounts have connected from this IP recently —
   *  the core "one machine farming many free trials" signal. */
  countDistinctAccountsFromIp(ip: string, sinceMs: number): number {
    if (!ip || ip === 'unknown') return 0;
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT account_login) AS n FROM abuse_signals
         WHERE ip = ? AND created_at >= ? AND account_login IS NOT NULL`,
      )
      .get(ip, since) as { n: number };
    return row.n;
  }

  /** Cheap liveness probe for /ready — throws if the DB is unreachable/locked. */
  pingDb(): void {
    this.db.prepare('SELECT 1').get();
  }

  /** Clear rows left 'running' by a crash/restart so the dashboard doesn't show a
   *  stuck spinner. Marked 'skipped' (not 'failed') because graceful restarts
   *  re-queue the job — the interrupted attempt is retried, not a real failure. */
  failStaleRunningRuns(): number {
    const res = this.db
      .prepare(
        `UPDATE review_runs SET status = 'skipped', skip_reason = 'interrupted by restart — retried'
         WHERE status = 'running'`,
      )
      .run();
    return res.changes;
  }

  /**
   * Bounded retention. Deletes only EPHEMERAL rows — never 'completed' reviews,
   * which the lifetime trial cap counts forever (pruning those would let a
   * farmer reset their trial by waiting). Targets the fastest-growing junk: the
   * 'skipped'/'failed' rows that every cooldown/limit/misfire inserts, expired
   * sessions, and old abuse signals. Safe to run on a schedule.
   */
  pruneEphemeralData(opts: { runRetentionMs?: number; abuseRetentionMs?: number } = {}): number {
    const runCutoff = new Date(Date.now() - (opts.runRetentionMs ?? 30 * 24 * 3_600_000)).toISOString();
    const abuseCutoff = new Date(Date.now() - (opts.abuseRetentionMs ?? 90 * 24 * 3_600_000)).toISOString();
    const now = new Date().toISOString();
    let n = 0;
    n += this.db
      .prepare(`DELETE FROM review_runs WHERE status IN ('skipped', 'failed') AND created_at < ?`)
      .run(runCutoff).changes;
    n += this.db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM mfa_challenges WHERE expires_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM auth_rate_limits WHERE reset_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM abuse_signals WHERE created_at < ?`).run(abuseCutoff).changes;
    return n;
  }

  /** Add email/password columns to an existing users table (email/password login). */
  private migrateUserAuthColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('email')) this.db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
    if (!names.has('google_id')) this.db.exec(`ALTER TABLE users ADD COLUMN google_id TEXT`);
    if (!names.has('password_hash')) this.db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
    if (!names.has('is_superadmin')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0`);
    }
    // normalized_email: the alias-collapsed identity (gmail dots/+tags folded) so
    // `john.doe+1@gmail.com` and `johndoe@gmail.com` map to ONE account. Anchors
    // email-alias anti-farming. Non-unique index (a user could legitimately share
    // a normalized email across OAuth + password linkage; dedup is enforced in the
    // signup paths, not by a hard constraint that could break linking).
    if (!names.has('normalized_email')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN normalized_email TEXT`);
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_users_normalized_email ON users(normalized_email) WHERE normalized_email IS NOT NULL`,
    );
    // DEDUP BEFORE CREATE: if historical rows already share an email (possible
    // from pre-constraint writes), CREATE UNIQUE INDEX throws and the server
    // crash-loops at startup. Null out the duplicates first (keeping the OLDEST
    // row's email, matching the case-insensitive lookup in getUserByEmail) and
    // log loudly — affected users can re-add their email from the dashboard.
    const dupes = this.db
      .prepare(
        `UPDATE users SET email = NULL
         WHERE email IS NOT NULL AND rowid NOT IN (
           SELECT MIN(rowid) FROM users WHERE email IS NOT NULL GROUP BY lower(email)
         )`,
      )
      .run();
    if (dupes.changes > 0) {
      console.warn(`[store] nulled ${dupes.changes} duplicate user email(s) so the unique index can be created`);
    }
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL`,
    );
  }

  private migrateUserSecurityColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(user_security)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'last_totp_epoch')) {
      this.db.exec(`ALTER TABLE user_security ADD COLUMN last_totp_epoch INTEGER`);
    }
  }

  private migrateLegacyPrReviews(): void {
    const cols = this.db.prepare(`PRAGMA table_info(pr_reviews)`).all() as Array<{ name: string }>;
    if (cols.length === 0) return;
    if (cols.some((c) => c.name === 'installation_id')) return;

    this.db.exec(`
      ALTER TABLE pr_reviews RENAME TO pr_reviews_legacy;
      CREATE TABLE pr_reviews (
        installation_id INTEGER NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr INTEGER NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'legacy',
        last_sha TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        last_review_at TEXT NOT NULL,
        last_summary_comment_id INTEGER,
        PRIMARY KEY (installation_id, owner, repo, pr)
      );
      DROP TABLE pr_reviews_legacy;
    `);
  }

  // ——— Tenants ———

  createTenant(slug: string, name?: string): Tenant {
    const id = randomUUID();
    const now = new Date().toISOString();
    const normalized = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    // New signups start on the FREE trial, not the paid default. Overridable via
    // ORVEX_DEFAULT_PLAN for dev/self-host. (The column default stays 'review' for
    // backward compatibility with tenants created before plans existed.)
    const plan = process.env.ORVEX_DEFAULT_PLAN || 'free';
    this.db
      .prepare(`INSERT INTO tenants (id, slug, name, created_at, plan) VALUES (?, ?, ?, ?, ?)`)
      .run(id, normalized, name ?? normalized, now, plan);
    return { id, slug: normalized, name: name ?? normalized, createdAt: now };
  }

  getTenantBySlug(slug: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, slug, name, created_at FROM tenants WHERE slug = ?`)
      .get(slug.toLowerCase()) as
      | { id: string; slug: string; name: string; created_at: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at };
  }

  getOrCreateTenant(slug: string, name?: string): Tenant {
    return this.getTenantBySlug(slug) ?? this.createTenant(slug, name);
  }

  /**
   * Slug of the most "active" tenant for the legacy dashboard's default view:
   * the one with the most tracked repos, then the one with a live installation,
   * then the earliest created. Avoids landing on an empty demo workspace.
   */
  firstTenantSlug(): string | null {
    const row = this.db
      .prepare(
        `SELECT t.slug,
                (SELECT COUNT(*) FROM repos r WHERE r.tenant_id = t.id) AS repo_count,
                (SELECT COUNT(*) FROM github_installations gi WHERE gi.tenant_id = t.id AND gi.suspended_at IS NULL) AS inst_count
         FROM tenants t
         ORDER BY inst_count DESC, repo_count DESC, t.created_at ASC
         LIMIT 1`,
      )
      .get() as { slug: string } | undefined;
    return row?.slug ?? null;
  }

  getTenantById(id: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, slug, name, created_at FROM tenants WHERE id = ?`)
      .get(id) as { id: string; slug: string; name: string; created_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at };
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
    const now = new Date().toISOString();
    const existing = this.getInstallation(input.installationId);
    const createdAt = existing?.createdAt ?? now;

    this.db
      .prepare(
        `INSERT INTO github_installations
         (installation_id, tenant_id, account_login, account_type, repository_selection, suspended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           account_login = excluded.account_login,
           account_type = excluded.account_type,
           repository_selection = excluded.repository_selection,
           suspended_at = excluded.suspended_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.installationId,
        input.tenantId,
        input.accountLogin,
        input.accountType,
        input.repositorySelection ?? 'selected',
        input.suspendedAt ?? null,
        createdAt,
        now,
      );

    return this.getInstallation(input.installationId)!;
  }

  getInstallation(installationId: number): GitHubInstallation | null {
    const row = this.db
      .prepare(
        `SELECT installation_id, tenant_id, account_login, account_type, repository_selection,
                suspended_at, created_at, updated_at
         FROM github_installations WHERE installation_id = ?`,
      )
      .get(installationId) as
      | {
          installation_id: number;
          tenant_id: string;
          account_login: string;
          account_type: string;
          repository_selection: string;
          suspended_at: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;
    return {
      installationId: row.installation_id,
      tenantId: row.tenant_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      suspendedAt: row.suspended_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getInstallationsForTenant(tenantId: string): GitHubInstallation[] {
    const rows = this.db
      .prepare(
        `SELECT installation_id, tenant_id, account_login, account_type, repository_selection,
                suspended_at, created_at, updated_at
         FROM github_installations WHERE tenant_id = ? ORDER BY updated_at DESC`,
      )
      .all(tenantId) as Array<{
        installation_id: number;
        tenant_id: string;
        account_login: string;
        account_type: string;
        repository_selection: string;
        suspended_at: string | null;
        created_at: string;
        updated_at: string;
      }>;

    return rows.map((row) => ({
      installationId: row.installation_id,
      tenantId: row.tenant_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      suspendedAt: row.suspended_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  findInstallationForRepo(owner: string, repo: string): GitHubInstallation | null {
    void repo; // keyed by account owner — the repo segment is not needed for the lookup
    const bySlug = this.db
      .prepare(
        `SELECT gi.installation_id FROM github_installations gi
         JOIN tenants t ON t.id = gi.tenant_id
         WHERE lower(gi.account_login) = lower(?) AND gi.suspended_at IS NULL
         LIMIT 1`,
      )
      .get(owner) as { installation_id: number } | undefined;

    return bySlug ? this.getInstallation(bySlug.installation_id) : null;
  }

  // ——— PR review state ———

  getState(key: PrKey): PrReviewState | null {
    const row = this.db
      .prepare(
        `SELECT tenant_id, last_sha, findings_json, last_review_at, last_summary_comment_id, codex_thread_id
         FROM pr_reviews
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | {
          tenant_id: string;
          last_sha: string;
          findings_json: string;
          last_review_at: string;
          last_summary_comment_id: number | null;
          codex_thread_id: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      installationId: key.installationId,
      tenantId: row.tenant_id,
      owner: key.owner,
      repo: key.repo,
      pr: key.pr,
      lastSha: row.last_sha,
      findings: JSON.parse(row.findings_json),
      lastReviewAt: row.last_review_at,
      lastSummaryCommentId: row.last_summary_comment_id ?? undefined,
      codexThreadId: row.codex_thread_id ?? undefined,
    };
  }

  saveState(state: PrReviewState): void {
    // ONE transaction: the pr_reviews upsert and the findings projection must
    // commit or fail TOGETHER — a crash between them leaves the dashboard
    // projection permanently out of sync with the operational blob.
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO pr_reviews
         (installation_id, owner, repo, pr, tenant_id, last_sha, findings_json, last_review_at, last_summary_comment_id, codex_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           last_sha = excluded.last_sha,
           findings_json = excluded.findings_json,
           last_review_at = excluded.last_review_at,
           last_summary_comment_id = excluded.last_summary_comment_id,
           codex_thread_id = excluded.codex_thread_id`,
        )
        .run(
          state.installationId,
          state.owner,
          state.repo,
          state.pr,
          state.tenantId,
          state.lastSha,
          JSON.stringify(state.findings),
          state.lastReviewAt,
          state.lastSummaryCommentId ?? null,
          state.codexThreadId ?? null,
        );

      // keep the dashboard findings projection in sync with the operational blob
      this.projectFindings(
        {
          tenantId: state.tenantId,
          installationId: state.installationId,
          owner: state.owner,
          repo: state.repo,
          pr: state.pr,
        },
        state.findings,
      );
    })();
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
    const email = input.email?.trim().toLowerCase();
    const normEmail = input.normalizedEmail ?? email ?? null;
    const now = new Date().toISOString();
    const existingGitHub = this.getUserByGitHubId(input.githubId);
    if (existingGitHub) {
      const emailOwner = email ? this.getUserByEmail(email) : null;
      this.db
        .prepare(
          `UPDATE users
           SET login = ?, name = ?, avatar_url = ?, email = CASE WHEN ? IS NULL OR ? IS NOT NULL THEN email ELSE ? END
           WHERE id = ?`,
        )
        .run(
          input.login,
          input.name ?? null,
          input.avatarUrl ?? null,
          email ?? null,
          emailOwner && emailOwner.id !== existingGitHub.id ? emailOwner.id : null,
          email ?? null,
          existingGitHub.id,
        );
      return this.getUserById(existingGitHub.id)!;
    }

    const existingEmail = email ? this.getUserByEmail(email) : null;
    if (existingEmail) {
      if (existingEmail.githubId > 0) {
        throw new Error('This email is already linked to a different GitHub account');
      }
      this.db
        .prepare(`UPDATE users SET github_id = ?, login = ?, name = ?, avatar_url = ?, email = ? WHERE id = ?`)
        .run(input.githubId, input.login, input.name ?? null, input.avatarUrl ?? null, email, existingEmail.id);
      return this.getUserById(existingEmail.id)!;
    }

    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, avatar_url, email, normalized_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.githubId, input.login, input.name ?? null, input.avatarUrl ?? null, email ?? null, normEmail, now);
    return this.getUserByGitHubId(input.githubId)!;
  }

  /** Set normalized_email when it's currently missing (backfills existing accounts
   *  on their next login without touching the delicate OAuth-link branches). */
  setUserNormalizedEmailIfMissing(userId: string, normalizedEmail: string): void {
    this.db
      .prepare(`UPDATE users SET normalized_email = ? WHERE id = ? AND normalized_email IS NULL`)
      .run(normalizedEmail.trim().toLowerCase(), userId);
  }

  getUserByGitHubId(githubId: number): User | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE github_id = ?`)
      .get(githubId) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  upsertUserFromGoogle(input: {
    googleId: string;
    email: string;
    name?: string | null;
    avatarUrl?: string | null;
    normalizedEmail?: string;
  }): User {
    const email = input.email.trim().toLowerCase();
    const existingGoogle = this.getUserByGoogleId(input.googleId);
    if (existingGoogle) {
      this.db
        .prepare(`UPDATE users SET name = ?, avatar_url = ?, email = ? WHERE id = ?`)
        .run(input.name ?? null, input.avatarUrl ?? null, email, existingGoogle.id);
      return this.getUserById(existingGoogle.id)!;
    }

    const existingEmail = this.getUserByEmail(email);
    if (existingEmail) {
      const linkedGoogleId = this.db
        .prepare(`SELECT google_id FROM users WHERE id = ?`)
        .get(existingEmail.id) as { google_id: string | null } | undefined;
      if (linkedGoogleId?.google_id) {
        throw new Error('This email is already linked to a different Google account');
      }
      this.db
        .prepare(`UPDATE users SET google_id = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?`)
        .run(input.googleId, input.name ?? null, input.avatarUrl ?? null, existingEmail.id);
      return this.getUserById(existingEmail.id)!;
    }

    const syntheticGithubId = syntheticUserId(`google:${input.googleId}`);
    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, avatar_url, email, normalized_email, google_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        syntheticGithubId,
        email,
        input.name ?? null,
        input.avatarUrl ?? null,
        email,
        input.normalizedEmail ?? email,
        input.googleId,
        new Date().toISOString(),
      );
    return this.getUserByGoogleId(input.googleId)!;
  }

  getUserByGoogleId(googleId: string): User | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE google_id = ?`)
      .get(googleId) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserById(id: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  // ——— Email/password auth ———

  /** Create (or update the password of) an email/password user. */
  upsertPasswordUser(input: {
    email: string;
    passwordHash: string;
    name?: string;
    login?: string;
  }): User {
    const email = input.email.toLowerCase().trim();
    const now = new Date().toISOString();
    const existing = this.getUserByEmail(email);
    if (existing) {
      this.db
        .prepare(`UPDATE users SET password_hash = ?, name = COALESCE(?, name) WHERE id = ?`)
        .run(input.passwordHash, input.name ?? null, existing.id);
      return this.getUserById(existing.id)!;
    }
    // password-only users get a synthetic negative github_id (real ids are > 0)
    const syntheticGithubId = syntheticUserId(email);
    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, email, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        syntheticGithubId,
        input.login ?? email,
        input.name ?? null,
        email,
        input.passwordHash,
        now,
      );
    return this.getUserByEmail(email)!;
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
    const email = input.email.toLowerCase().trim();
    const now = new Date().toISOString();
    const syntheticGithubId = syntheticUserId(email);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO users (id, github_id, login, name, email, normalized_email, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        syntheticGithubId,
        input.login ?? email,
        input.name ?? null,
        email,
        input.normalizedEmail ?? email,
        input.passwordHash,
        now,
      );
    return result.changes === 1 ? this.getUserByEmail(email) : null;
  }

  getUserByEmail(email: string): User | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`)
      .get(email.trim()) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  /** Any existing account whose normalized (alias-collapsed) email matches — the
   *  anchor for email-alias anti-farming. Caller passes a value from
   *  tenants.normalizeEmail. Returns the first match (accounts are deduped at
   *  signup, so there should be at most one). */
  getUserByNormalizedEmail(normalizedEmail: string): User | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE normalized_email = ? LIMIT 1`)
      .get(normalizedEmail.trim().toLowerCase()) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  getPasswordHash(userId: string): string | null {
    const row = this.db
      .prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .get(userId) as { password_hash: string | null } | undefined;
    return row?.password_hash ?? null;
  }

  setUserSuperAdmin(userId: string, enabled: boolean): boolean {
    return this.db
      .prepare(`UPDATE users SET is_superadmin = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, userId).changes > 0;
  }

  getUserSecurity(userId: string): UserSecurity {
    const row = this.db
      .prepare(
        `SELECT user_id, totp_enabled, totp_secret_encrypted, last_totp_epoch,
                recovery_code_hashes_json, updated_at
         FROM user_security WHERE user_id = ?`,
      )
      .get(userId) as
      | {
          user_id: string;
          totp_enabled: number;
          totp_secret_encrypted: string | null;
          last_totp_epoch: number | null;
          recovery_code_hashes_json: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return {
        userId,
        totpEnabled: false,
        recoveryCodeHashes: [],
        updatedAt: new Date(0).toISOString(),
      };
    }
    let recoveryCodeHashes: string[] = [];
    try {
      const parsed = JSON.parse(row.recovery_code_hashes_json) as unknown;
      if (Array.isArray(parsed)) recoveryCodeHashes = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      /* malformed recovery data fails closed: no codes are accepted */
    }
    return {
      userId: row.user_id,
      totpEnabled: Boolean(row.totp_enabled),
      totpSecretEncrypted: row.totp_secret_encrypted ?? undefined,
      lastTotpEpoch: row.last_totp_epoch ?? undefined,
      recoveryCodeHashes,
      updatedAt: row.updated_at,
    };
  }

  setPendingTotpSecret(userId: string, encryptedSecret: string): boolean {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `INSERT INTO user_security
         (user_id, totp_enabled, totp_secret_encrypted, recovery_code_hashes_json, updated_at)
         VALUES (?, 0, ?, '[]', ?)
         ON CONFLICT(user_id) DO UPDATE SET
           totp_enabled = 0,
           totp_secret_encrypted = excluded.totp_secret_encrypted,
           last_totp_epoch = NULL,
           recovery_code_hashes_json = '[]',
           updated_at = excluded.updated_at
         WHERE user_security.totp_enabled = 0`,
      )
      .run(userId, encryptedSecret, now).changes > 0;
  }

  enableTotp(userId: string, recoveryCodeHashes: string[]): boolean {
    return this.db
      .prepare(
         `UPDATE user_security
         SET totp_enabled = 1, recovery_code_hashes_json = ?, updated_at = ?
         WHERE user_id = ? AND totp_enabled = 0 AND totp_secret_encrypted IS NOT NULL`,
      )
      .run(JSON.stringify(recoveryCodeHashes), new Date().toISOString(), userId).changes > 0;
  }

  completeTotpEnrollment(input: {
    userId: string;
    expectedEncryptedSecret: string;
    totpEpoch: number;
    recoveryCodeHashes: string[];
    sessionTtlMs?: number;
  }): Session | null {
    if (!validTotpEpoch(input.totpEpoch)) return null;
    const tx = this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE user_security
           SET totp_enabled = 1, last_totp_epoch = ?, recovery_code_hashes_json = ?, updated_at = ?
           WHERE user_id = ? AND totp_enabled = 0 AND totp_secret_encrypted = ?`,
        )
        .run(
          input.totpEpoch,
          JSON.stringify(input.recoveryCodeHashes),
          new Date().toISOString(),
          input.userId,
          input.expectedEncryptedSecret,
        );
      if (updated.changes !== 1) return null;
      this.clearMfaStateForUser(input.userId);
      return this.replaceUserSessions(input.userId, input.sessionTtlMs);
    });
    return tx();
  }

  disableTotpAndRotateSession(input: {
    userId: string;
    factor: { totpEpoch: number } | { recoveryCodeHash: string };
    sessionTtlMs?: number;
  }): Session | null {
    const tx = this.db.transaction(() => {
      const security = this.securityFactorRow(input.userId);
      if (!security || !this.securityFactorIsFresh(security, input.factor)) return null;
      const deleted = this.db.prepare(`DELETE FROM user_security WHERE user_id = ?`).run(input.userId);
      if (deleted.changes !== 1) return null;
      this.clearMfaStateForUser(input.userId);
      return this.replaceUserSessions(input.userId, input.sessionTtlMs);
    });
    return tx();
  }

  regenerateRecoveryCodesAndRotateSession(input: {
    userId: string;
    totpEpoch: number;
    recoveryCodeHashes: string[];
    sessionTtlMs?: number;
  }): Session | null {
    if (!validTotpEpoch(input.totpEpoch)) return null;
    const tx = this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE user_security
           SET last_totp_epoch = ?, recovery_code_hashes_json = ?, updated_at = ?
           WHERE user_id = ? AND totp_enabled = 1
             AND (last_totp_epoch IS NULL OR last_totp_epoch < ?)`,
        )
        .run(
          input.totpEpoch,
          JSON.stringify(input.recoveryCodeHashes),
          new Date().toISOString(),
          input.userId,
          input.totpEpoch,
        );
      if (updated.changes !== 1) return null;
      this.clearMfaStateForUser(input.userId);
      return this.replaceUserSessions(input.userId, input.sessionTtlMs);
    });
    return tx();
  }

  disableTotp(userId: string): void {
    this.db.prepare(`DELETE FROM user_security WHERE user_id = ?`).run(userId);
  }

  consumeRecoveryCode(userId: string, codeHash: string): boolean {
    const security = this.getUserSecurity(userId);
    const index = security.recoveryCodeHashes.indexOf(codeHash);
    if (!security.totpEnabled || index < 0) return false;
    const remaining = security.recoveryCodeHashes.filter((_, i) => i !== index);
    return this.db
      .prepare(
        `UPDATE user_security SET recovery_code_hashes_json = ?, updated_at = ?
         WHERE user_id = ? AND recovery_code_hashes_json = ?`,
      )
      .run(
        JSON.stringify(remaining),
        new Date().toISOString(),
        userId,
        JSON.stringify(security.recoveryCodeHashes),
      ).changes > 0;
  }

  acceptTotpEpoch(userId: string, epoch: number): boolean {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
    return this.db
      .prepare(
        `UPDATE user_security SET last_totp_epoch = ?, updated_at = ?
         WHERE user_id = ? AND totp_enabled = 1
           AND (last_totp_epoch IS NULL OR last_totp_epoch < ?)`,
      )
      .run(epoch, new Date().toISOString(), userId, epoch).changes > 0;
  }

  consumeAuthAttempt(
    rateKey: string,
    opts: { windowMs: number; max: number },
    now = Date.now(),
  ): { allowed: boolean; retryAfterSeconds: number } {
    if (!rateKey || !Number.isFinite(opts.windowMs) || opts.windowMs <= 0 || !Number.isInteger(opts.max) || opts.max <= 0) {
      return { allowed: false, retryAfterSeconds: 1 };
    }
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT attempt_count, reset_at FROM auth_rate_limits WHERE rate_key = ?`)
        .get(rateKey) as { attempt_count: number; reset_at: string } | undefined;
      const resetAt = row ? new Date(row.reset_at).getTime() : 0;
      if (!row || !Number.isFinite(resetAt) || resetAt <= now) {
        this.db
          .prepare(
            `INSERT INTO auth_rate_limits (rate_key, attempt_count, reset_at) VALUES (?, 1, ?)
             ON CONFLICT(rate_key) DO UPDATE SET attempt_count = 1, reset_at = excluded.reset_at`,
          )
          .run(rateKey, new Date(now + opts.windowMs).toISOString());
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (row.attempt_count >= opts.max) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
      }
      this.db.prepare(`UPDATE auth_rate_limits SET attempt_count = attempt_count + 1 WHERE rate_key = ?`).run(rateKey);
      return { allowed: true, retryAfterSeconds: 0 };
    });
    return tx();
  }

  clearAuthAttempts(rateKey: string): void {
    this.db.prepare(`DELETE FROM auth_rate_limits WHERE rate_key = ?`).run(rateKey);
  }

  consumeMfaAttempt(
    userId: string,
    opts: { windowMs: number; max: number },
    now = Date.now(),
  ): { allowed: boolean; retryAfterSeconds: number } {
    return this.consumeAuthAttempt(`mfa:${userId}`, opts, now);
  }

  clearMfaAttempts(userId: string): void {
    this.clearAuthAttempts(`mfa:${userId}`);
  }

  createMfaChallenge(userId: string, next: string, ttlMs = 5 * 60_000): MfaChallenge {
    const createdAt = new Date();
    const challenge: MfaChallenge = {
      id: randomUUID(),
      userId,
      next,
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      createdAt: createdAt.toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO mfa_challenges (id, user_id, next, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(challenge.id, challenge.userId, challenge.next, challenge.expiresAt, challenge.createdAt);
    return challenge;
  }

  getMfaChallenge(id: string): MfaChallenge | null {
    const row = this.db
      .prepare(`SELECT id, user_id, next, expires_at, created_at FROM mfa_challenges WHERE id = ?`)
      .get(id) as
      | { id: string; user_id: string; next: string; expires_at: string; created_at: string }
      | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.deleteMfaChallenge(id);
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      next: row.next,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  consumeMfaChallenge(id: string): MfaChallenge | null {
    const tx = this.db.transaction(() => {
      const challenge = this.getMfaChallenge(id);
      if (!challenge) return null;
      const deleted = this.db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`).run(id);
      return deleted.changes === 1 ? challenge : null;
    });
    return tx();
  }

  completeMfaChallenge(
    challengeId: string,
    factor: { totpEpoch: number } | { recoveryCodeHash: string },
    sessionTtlMs = 30 * 24 * 3_600_000,
  ): { challenge: MfaChallenge; session: Session } | null {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT c.id, c.user_id, c.next, c.expires_at, c.created_at,
                  s.totp_enabled, s.last_totp_epoch, s.recovery_code_hashes_json
           FROM mfa_challenges c
           JOIN user_security s ON s.user_id = c.user_id
           WHERE c.id = ?`,
        )
        .get(challengeId) as ChallengeFactorRow | undefined;
      if (!row || !row.totp_enabled) return null;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        this.db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`).run(challengeId);
        return null;
      }
      if (!this.securityFactorIsFresh(row, factor)) return null;

      const deleted = this.db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`).run(challengeId);
      if (deleted.changes !== 1) return null;

      if ('totpEpoch' in factor) {
        const updated = this.db
          .prepare(
            `UPDATE user_security SET last_totp_epoch = ?, updated_at = ?
             WHERE user_id = ? AND totp_enabled = 1
               AND (last_totp_epoch IS NULL OR last_totp_epoch < ?)`,
          )
          .run(factor.totpEpoch, new Date().toISOString(), row.user_id, factor.totpEpoch);
        if (updated.changes !== 1) throw new Error('MFA replay state changed during challenge completion');
      } else {
        const hashes = parseStringArray(row.recovery_code_hashes_json);
        const remaining = hashes.filter((hash) => hash !== factor.recoveryCodeHash);
        const updated = this.db
          .prepare(
            `UPDATE user_security SET recovery_code_hashes_json = ?, updated_at = ?
             WHERE user_id = ? AND totp_enabled = 1 AND recovery_code_hashes_json = ?`,
          )
          .run(
            JSON.stringify(remaining),
            new Date().toISOString(),
            row.user_id,
            row.recovery_code_hashes_json,
          );
        if (updated.changes !== 1) throw new Error('MFA recovery state changed during challenge completion');
      }

      this.clearMfaAttempts(row.user_id);
      return {
        challenge: {
          id: row.id,
          userId: row.user_id,
          next: row.next,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        },
        session: this.createSession(row.user_id, sessionTtlMs),
      };
    });
    return tx();
  }

  deleteMfaChallenge(id: string): void {
    this.db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`).run(id);
  }

  deleteMfaChallengesForUser(userId: string): void {
    this.db.prepare(`DELETE FROM mfa_challenges WHERE user_id = ?`).run(userId);
  }

  private securityFactorRow(userId: string): SecurityFactorRow | null {
    const row = this.db
      .prepare(
        `SELECT totp_enabled, last_totp_epoch, recovery_code_hashes_json
         FROM user_security WHERE user_id = ?`,
      )
      .get(userId) as SecurityFactorRow | undefined;
    return row ?? null;
  }

  private securityFactorIsFresh(
    row: SecurityFactorRow,
    factor: { totpEpoch: number } | { recoveryCodeHash: string },
  ): boolean {
    if (!row.totp_enabled) return false;
    if ('totpEpoch' in factor) {
      return validTotpEpoch(factor.totpEpoch)
        && (row.last_totp_epoch === null || row.last_totp_epoch < factor.totpEpoch);
    }
    return parseStringArray(row.recovery_code_hashes_json).includes(factor.recoveryCodeHash);
  }

  private clearMfaStateForUser(userId: string): void {
    this.db.prepare(`DELETE FROM mfa_challenges WHERE user_id = ?`).run(userId);
    this.db
      .prepare(`DELETE FROM auth_rate_limits WHERE rate_key IN (?, ?, ?, ?)`)
      .run(
        `mfa:${userId}`,
        `security:enable:${userId}`,
        `security:disable:${userId}`,
        `security:recovery:${userId}`,
      );
  }

  private replaceUserSessions(userId: string, ttlMs = 30 * 24 * 3_600_000): Session {
    this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
    return this.createSession(userId, ttlMs);
  }

  /** True if any email/password account exists — used to require login. */
  hasPasswordUsers(): boolean {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL`)
      .get() as { n: number };
    return row.n > 0;
  }

  createSession(userId: string, ttlMs = 30 * 24 * 3_600_000): Session {
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db
      .prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, userId, expiresAt, now.toISOString());
    return { id, userId, expiresAt, createdAt: now.toISOString() };
  }

  getSessionUser(sessionId: string): User | null {
    const row = this.db
      .prepare(`SELECT user_id, expires_at FROM sessions WHERE id = ?`)
      .get(sessionId) as { user_id: string; expires_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.deleteSession(sessionId);
      return null;
    }
    return this.getUserById(row.user_id);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  deleteSessionsForUser(userId: string): number {
    return this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId).changes;
  }

  // ——— Workspace membership ———

  addWorkspaceMember(tenantId: string, userId: string, role: WorkspaceRole): WorkspaceMember {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_members (tenant_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(tenantId, userId, role, now);
    return { tenantId, userId, role, createdAt: now };
  }

  getMembership(tenantId: string, userId: string): WorkspaceMember | null {
    const row = this.db
      .prepare(`SELECT * FROM workspace_members WHERE tenant_id = ? AND user_id = ?`)
      .get(tenantId, userId) as
      | { tenant_id: string; user_id: string; role: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role as WorkspaceRole,
      createdAt: row.created_at,
    };
  }

  getWorkspacesForUser(userId: string): Array<{ tenant: Tenant; role: WorkspaceRole }> {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.slug, t.name, t.created_at, m.role
         FROM workspace_members m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = ? ORDER BY t.created_at`,
      )
      .all(userId) as Array<{ id: string; slug: string; name: string; created_at: string; role: string }>;
    return rows.map((r) => ({
      tenant: { id: r.id, slug: r.slug, name: r.name, createdAt: r.created_at },
      role: r.role as WorkspaceRole,
    }));
  }

  /** True if the tenant has no members yet (pre-auth workspace or freshly created). */
  tenantHasMembers(tenantId: string): boolean {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE tenant_id = ?`)
      .get(tenantId) as { n: number };
    return row.n > 0;
  }

  // ——— PR settings (auto-apply) ———

  getPrSettings(key: PrKey): PrSettings {
    const row = this.db
      .prepare(
        `SELECT auto_apply, updated_at FROM pr_settings
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | { auto_apply: number; updated_at: string }
      | undefined;

    // Effective auto-apply cascades: per-PR override → per-repo toggle →
    // workspace default. Without this, the dashboard repo/workspace toggles
    // were silent no-ops (only the `@orvex auto-apply` PR command took effect).
    let autoApply = row ? Boolean(row.auto_apply) : undefined;
    if (autoApply === undefined) {
      const repo = this.getRepoByFullName(key.installationId, `${key.owner}/${key.repo}`);
      if (repo?.autoApply) {
        autoApply = true;
      } else if (repo) {
        const inst = this.getInstallation(key.installationId);
        autoApply = inst ? this.getWorkspaceSettings(inst.tenantId).autoApplyDefault : false;
      } else {
        autoApply = false;
      }
    }

    return {
      installationId: key.installationId,
      owner: key.owner,
      repo: key.repo,
      pr: key.pr,
      autoApply,
      updatedAt: row?.updated_at ?? new Date().toISOString(),
    };
  }

  setPrAutoApply(key: PrKey, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO pr_settings (installation_id, owner, repo, pr, auto_apply, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET
           auto_apply = excluded.auto_apply,
           updated_at = excluded.updated_at`,
      )
      .run(key.installationId, key.owner, key.repo, key.pr, enabled ? 1 : 0, new Date().toISOString());
  }

  // ——— Fix locks (one fix operation per PR at a time) ———

  acquireFixLock(key: PrKey, holder: string, staleMs = 300_000): boolean {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT holder, acquired_at FROM fix_locks
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | { holder: string; acquired_at: string }
      | undefined;

    if (row && now - new Date(row.acquired_at).getTime() < staleMs) {
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO fix_locks (installation_id, owner, repo, pr, holder, acquired_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET
           holder = excluded.holder,
           acquired_at = excluded.acquired_at`,
      )
      .run(key.installationId, key.owner, key.repo, key.pr, holder, new Date(now).toISOString());
    return true;
  }

  releaseFixLock(key: PrKey, holder: string): void {
    this.db
      .prepare(
        `DELETE FROM fix_locks
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ? AND holder = ?`,
      )
      .run(key.installationId, key.owner, key.repo, key.pr, holder);
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
    this.db
      .prepare(
        `INSERT INTO finding_suppressions
         (installation_id, owner, repo, fingerprint, rule_id, suppressed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, fingerprint) DO NOTHING`,
      )
      .run(
        input.installationId,
        input.owner,
        input.repo,
        input.fingerprint,
        input.ruleId ?? null,
        input.suppressedBy ?? null,
        new Date().toISOString(),
      );
  }

  getSuppressedFingerprints(installationId: number, owner: string, repo: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT fingerprint FROM finding_suppressions
         WHERE installation_id = ? AND owner = ? AND repo = ?`,
      )
      .all(installationId, owner, repo) as Array<{ fingerprint: string }>;
    return new Set(rows.map((r) => r.fingerprint));
  }

  /** Fix commits on this PR in the last `sinceMs` — the runaway-loop guard. */
  countRecentFixRuns(key: PrKey, sinceMs = 86_400_000): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?
           AND action LIKE 'fix:%' AND status = 'completed' AND created_at >= ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr, since) as { n: number };
    return row.n;
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
    const id = randomUUID();
    const now = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO review_runs
         (id, tenant_id, installation_id, owner, repo, pr, head_sha, action, status,
          skip_reason, error, duration_ms, findings_new, findings_fixed, findings_open, deep, free_tier, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.installationId,
        input.owner,
        input.repo,
        input.pr,
        input.headSha,
        input.action,
        input.status,
        input.skipReason ?? null,
        input.error ?? null,
        input.durationMs,
        input.findingsNew ?? 0,
        input.findingsFixed ?? 0,
        input.findingsOpen ?? 0,
        input.deep ? 1 : 0,
        input.freeTier ? 1 : 0,
        now,
      );
    return {
      id,
      tenantId: input.tenantId,
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      pr: input.pr,
      headSha: input.headSha,
      action: input.action,
      status: input.status,
      skipReason: input.skipReason,
      error: input.error,
      durationMs: input.durationMs,
      findingsNew: input.findingsNew ?? 0,
      findingsFixed: input.findingsFixed ?? 0,
      findingsOpen: input.findingsOpen ?? 0,
      costUsd: 0,
      deep: Boolean(input.deep),
      createdAt: now,
    };
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
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO review_runs
         (id, tenant_id, installation_id, owner, repo, pr, head_sha, action, status,
          skip_reason, error, duration_ms, findings_new, findings_fixed, findings_open, deep, free_tier, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, 0, 0, 0, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.installationId,
        input.owner,
        input.repo,
        input.pr,
        input.headSha,
        input.action,
        input.deep ? 1 : 0,
        input.freeTier ? 1 : 0,
        now,
      );
    return id;
  }

  /** Global count of free-tier reviews started across ALL accounts in the last
   *  `sinceMs` — the anchor for the free-tier daily spend circuit-breaker. Counts
   *  running + completed (a farm's in-flight reviews cost money too). */
  countGlobalFreeTierReviewsSince(sinceMs: number): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE free_tier = 1 AND status IN ('running', 'completed')
           AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND created_at >= ?`,
      )
      .get(since) as { n: number };
    return row.n;
  }

  /** Re-point a running review at the ACTUAL head SHA being reviewed. The run row
   *  is created from the webhook payload's headSha up front, but by the time the
   *  worker fetches the PR a newer commit may have landed — the run must be
   *  recorded on the SHA that was really reviewed (cooldown/dedup/scorecard all
   *  key on head_sha). */
  setReviewRunHeadSha(id: string, headSha: string): void {
    this.db.prepare(`UPDATE review_runs SET head_sha = ? WHERE id = ?`).run(headSha, id);
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
    },
  ): void {
    this.db
      .prepare(
        `UPDATE review_runs
         SET status = ?, skip_reason = ?, error = ?, duration_ms = ?,
             findings_new = ?, findings_fixed = ?, findings_open = ?,
             input_tokens = ?, output_tokens = ?, cost_usd = ?,
             new_findings_json = ?
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.skipReason ?? null,
        patch.error ?? null,
        patch.durationMs,
        patch.findingsNew ?? 0,
        patch.findingsFixed ?? 0,
        patch.findingsOpen ?? 0,
        patch.inputTokens ?? 0,
        patch.outputTokens ?? 0,
        patch.costUsd ?? 0,
        patch.newFindings ? JSON.stringify(patch.newFindings) : null,
        id,
      );
  }

  /** Completed runs (all tenants) for the deep-vs-normal scorecard, oldest
   *  first so pairing walks each commit's runs in execution order. */
  listScorecardRuns(limit = 500): ScorecardRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, owner, repo, pr, head_sha, deep, duration_ms, cost_usd, created_at, new_findings_json
         FROM review_runs WHERE status = 'completed'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      owner: string;
      repo: string;
      pr: number;
      head_sha: string;
      deep: number;
      duration_ms: number;
      cost_usd: number;
      created_at: string;
      new_findings_json: string | null;
    }>;
    return rows.reverse().map((r) => {
      let newFindings: ScorecardRun['newFindings'] = [];
      try {
        newFindings = r.new_findings_json ? JSON.parse(r.new_findings_json) : [];
      } catch {
        /* malformed row — treat as no detail */
      }
      return {
        id: r.id,
        owner: r.owner,
        repo: r.repo,
        pr: r.pr,
        headSha: r.head_sha,
        deep: r.deep === 1,
        durationMs: r.duration_ms,
        costUsd: r.cost_usd,
        createdAt: r.created_at,
        newFindings,
      };
    });
  }

  /** Total LLM cost (USD) for an account over `sinceMs` — for owner spend
   *  visibility and quota/budget alerting. */
  sumAccountCost(owner: string, sinceMs = 30 * 24 * 3_600_000): { costUsd: number; reviews: number } {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS n FROM review_runs
         WHERE lower(owner) = lower(?) AND cost_usd > 0 AND created_at >= ?`,
      )
      .get(owner, since) as { cost: number; n: number };
    return { costUsd: row.cost, reviews: row.n };
  }

  listReviewRuns(tenantId: string, limit = 50): ReviewRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(tenantId, limit) as ReviewRunRow[];
    return rows.map(mapReviewRun);
  }

  getWorkspaceStats(tenantId: string, sinceDays = 14): WorkspaceStats {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS runs_total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS runs_completed,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS runs_skipped,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS runs_failed,
           SUM(findings_new) AS findings_new,
           SUM(findings_fixed) AS findings_fixed,
           SUM(cost_usd) AS cost_usd,
           AVG(CASE WHEN status = 'completed' THEN duration_ms END) AS avg_duration_ms
         FROM review_runs WHERE tenant_id = ? AND created_at >= ?`,
      )
      .get(tenantId, since) as {
        runs_total: number;
        runs_completed: number | null;
        runs_skipped: number | null;
        runs_failed: number | null;
        findings_new: number | null;
        findings_fixed: number | null;
        cost_usd: number | null;
        avg_duration_ms: number | null;
      };
    return {
      sinceDays,
      runsTotal: row.runs_total,
      runsCompleted: row.runs_completed ?? 0,
      runsSkipped: row.runs_skipped ?? 0,
      runsFailed: row.runs_failed ?? 0,
      findingsNew: row.findings_new ?? 0,
      findingsFixed: row.findings_fixed ?? 0,
      costUsd: row.cost_usd ?? 0,
      avgDurationMs: row.avg_duration_ms,
    };
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
    const now = new Date().toISOString();
    const existing = this.getRepoByGitHubId(input.installationId, input.githubRepoId);
    // preserve an operator's explicit enable/disable choice across resyncs
    const enabled = existing ? existing.enabled : (input.enabled ?? true);
    this.db
      .prepare(
        `INSERT INTO repos
         (id, installation_id, tenant_id, github_repo_id, owner, name, full_name, private,
          default_branch, enabled, review_mode, auto_apply, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 0, ?, ?)
         ON CONFLICT(installation_id, github_repo_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           owner = excluded.owner, name = excluded.name, full_name = excluded.full_name,
           private = excluded.private, default_branch = excluded.default_branch,
           updated_at = excluded.updated_at`,
      )
      .run(
        existing?.id ?? randomUUID(),
        input.installationId,
        input.tenantId,
        input.githubRepoId,
        input.owner,
        input.name,
        input.fullName,
        input.private ? 1 : 0,
        input.defaultBranch ?? null,
        enabled ? 1 : 0,
        existing?.addedAt ?? now,
        now,
      );
    return this.getRepoByGitHubId(input.installationId, input.githubRepoId)!;
  }

  getRepoByGitHubId(installationId: number, githubRepoId: number): Repo | null {
    const row = this.db
      .prepare(`SELECT * FROM repos WHERE installation_id = ? AND github_repo_id = ?`)
      .get(installationId, githubRepoId) as RepoRow | undefined;
    return row ? mapRepo(row) : null;
  }

  getRepoByFullName(installationId: number, fullName: string): Repo | null {
    const row = this.db
      .prepare(`SELECT * FROM repos WHERE installation_id = ? AND lower(full_name) = lower(?)`)
      .get(installationId, fullName) as RepoRow | undefined;
    return row ? mapRepo(row) : null;
  }

  listRepos(tenantId: string): Repo[] {
    const rows = this.db
      .prepare(`SELECT * FROM repos WHERE tenant_id = ? ORDER BY full_name`)
      .all(tenantId) as RepoRow[];
    return rows.map(mapRepo);
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
    const rows = this.db
      .prepare(
        `SELECT r.installation_id AS installationId, r.tenant_id AS tenantId, r.owner AS owner,
                r.name AS name, r.full_name AS fullName, r.default_branch AS defaultBranch, t.plan AS plan
         FROM repos r
         JOIN tenants t ON t.id = r.tenant_id
         JOIN github_installations gi ON gi.installation_id = r.installation_id
         WHERE r.enabled = 1 AND gi.suspended_at IS NULL`,
      )
      .all() as Array<{
      installationId: number;
      tenantId: string;
      owner: string;
      name: string;
      fullName: string;
      defaultBranch: string | null;
      plan: string;
    }>;
    return rows;
  }

  setRepoEnabled(repoId: string, enabled: boolean): void {
    this.db
      .prepare(`UPDATE repos SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), repoId);
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
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.reviewMode) {
      sets.push('review_mode = ?');
      vals.push(patch.reviewMode);
    }
    if (patch.autoApply !== undefined) {
      sets.push('auto_apply = ?');
      vals.push(patch.autoApply ? 1 : 0);
    }
    if (patch.reviewOnOpen !== undefined) {
      sets.push('review_on_open = ?');
      vals.push(patch.reviewOnOpen ? 1 : 0);
    }
    if (patch.reviewOnPush !== undefined) {
      sets.push('review_on_push = ?');
      vals.push(patch.reviewOnPush ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString(), repoId);
    this.db.prepare(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /**
   * Whether Orvex should review this repo. Unknown repos default to enabled
   * (honoring the workspace's auto_enable_new_repos), so reviews work before a
   * user visits the dashboard; explicit disables are always respected.
   */
  isRepoEnabled(installationId: number, fullName: string): boolean {
    const repo = this.getRepoByFullName(installationId, fullName);
    return repo ? repo.enabled : true;
  }

  /**
   * Whether Orvex should auto-review THIS specific trigger — the dashboard
   * settings-section toggles. `opened`/`reopened` are gated by reviewOnOpen;
   * `synchronize` (a new push to an open PR) by reviewOnPush. An unknown repo
   * defaults to true for both (same "on before the dashboard is visited"
   * reasoning as isRepoEnabled) so a fresh install isn't silently inert.
   */
  isRepoActionEnabled(installationId: number, fullName: string, action: string): boolean {
    const repo = this.getRepoByFullName(installationId, fullName);
    if (!repo) return true;
    if (action === 'synchronize') return repo.reviewOnPush;
    return repo.reviewOnOpen; // opened, reopened
  }

  // ——— Pull request lifecycle ———

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
    const now = new Date().toISOString();
    const existingId = (
      this.db
        .prepare(
          `SELECT id FROM pull_requests WHERE installation_id = ? AND repo_full_name = ? AND number = ?`,
        )
        .get(input.installationId, input.repoFullName, input.number) as { id: string } | undefined
    )?.id;
    this.db
      .prepare(
        `INSERT INTO pull_requests
         (id, tenant_id, installation_id, repo_full_name, number, title, author, state, draft,
          head_sha, url, opened_at, closed_at, merged_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, repo_full_name, number) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           title = excluded.title, author = excluded.author, state = excluded.state,
           draft = excluded.draft, head_sha = excluded.head_sha, url = excluded.url,
           closed_at = excluded.closed_at, merged_at = excluded.merged_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        existingId ?? randomUUID(),
        input.tenantId,
        input.installationId,
        input.repoFullName,
        input.number,
        input.title,
        input.author,
        input.state,
        input.draft ? 1 : 0,
        input.headSha,
        input.url ?? null,
        input.openedAt ?? now,
        input.closedAt ?? null,
        input.mergedAt ?? null,
        now,
      );
  }

  markReviewedNow(installationId: number, repoFullName: string, prNumber: number, openFindings: number): void {
    this.db
      .prepare(
        `UPDATE pull_requests SET last_reviewed_at = ?, open_findings = ?, updated_at = ?
         WHERE installation_id = ? AND repo_full_name = ? AND number = ?`,
      )
      .run(new Date().toISOString(), openFindings, new Date().toISOString(), installationId, repoFullName, prNumber);
  }

  listPullRequests(tenantId: string, opts: { state?: PullRequestState; limit?: number } = {}): PullRequest[] {
    const limit = opts.limit ?? 100;
    const rows = opts.state
      ? (this.db
          .prepare(`SELECT * FROM pull_requests WHERE tenant_id = ? AND state = ? ORDER BY updated_at DESC LIMIT ?`)
          .all(tenantId, opts.state, limit) as PullRequestRow[])
      : (this.db
          .prepare(`SELECT * FROM pull_requests WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?`)
          .all(tenantId, limit) as PullRequestRow[]);
    return rows.map(mapPullRequest);
  }

  getPullRequestCounts(tenantId: string): { open: number; merged: number; closed: number } {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM pull_requests WHERE tenant_id = ? GROUP BY state`)
      .all(tenantId) as Array<{ state: string; n: number }>;
    const counts = { open: 0, merged: 0, closed: 0 };
    for (const r of rows) if (r.state in counts) counts[r.state as keyof typeof counts] = r.n;
    return counts;
  }

  // ——— Findings projection (dashboard bug list) ———

  /** Replace the projected findings for one PR (called on every saveState). */
  projectFindings(
    key: { tenantId: string; installationId: number; owner: string; repo: string; pr: number },
    findings: StoredFinding[],
  ): void {
    const fullName = `${key.owner}/${key.repo}`;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM findings WHERE installation_id = ? AND repo_full_name = ? AND pr_number = ?`)
        .run(key.installationId, fullName, key.pr);
      const insert = this.db.prepare(
        `INSERT INTO findings
         (id, tenant_id, installation_id, repo_full_name, pr_number, fingerprint, file, line,
          severity, category, message, status, rule_id, github_comment_id, first_seen_sha,
          fixed_at_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const f of findings) {
        insert.run(
          randomUUID(),
          key.tenantId,
          key.installationId,
          fullName,
          key.pr,
          f.fingerprint,
          f.file,
          f.line ?? null,
          f.severity,
          f.category,
          f.message,
          f.status,
          f.ruleId,
          f.githubCommentId ?? null,
          f.firstSeenSha,
          f.fixedAtSha ?? null,
          now,
          now,
        );
      }
    });
    tx();
  }

  listFindings(
    tenantId: string,
    opts: { status?: FindingStatus; repoFullName?: string; limit?: number } = {},
  ): FindingRecord[] {
    const clauses = ['tenant_id = ?'];
    const vals: unknown[] = [tenantId];
    if (opts.status) {
      clauses.push('status = ?');
      vals.push(opts.status);
    }
    if (opts.repoFullName) {
      clauses.push('lower(repo_full_name) = lower(?)');
      vals.push(opts.repoFullName);
    }
    vals.push(opts.limit ?? 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM findings WHERE ${clauses.join(' AND ')}
         ORDER BY CASE severity WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 WHEN 'P3' THEN 2 ELSE 3 END,
                  updated_at DESC LIMIT ?`,
      )
      .all(...vals) as FindingRow[];
    return rows.map(mapFinding);
  }

  getFindingCounts(tenantId: string): { open: number; fixed: number; ignored: number; bySeverity: Record<string, number> } {
    const statusRows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM findings WHERE tenant_id = ? GROUP BY status`)
      .all(tenantId) as Array<{ status: string; n: number }>;
    const sevRows = this.db
      .prepare(`SELECT severity, COUNT(*) AS n FROM findings WHERE tenant_id = ? AND status = 'open' GROUP BY severity`)
      .all(tenantId) as Array<{ severity: string; n: number }>;
    const counts = { open: 0, fixed: 0, ignored: 0, bySeverity: {} as Record<string, number> };
    for (const r of statusRows) {
      if (r.status === 'open' || r.status === 'fixed' || r.status === 'ignored') counts[r.status] = r.n;
    }
    for (const r of sevRows) counts.bySeverity[r.severity] = r.n;
    return counts;
  }

  // ——— Workspace settings ———

  getWorkspaceSettings(tenantId: string): WorkspaceSettings {
    const row = this.db
      .prepare(`SELECT * FROM workspace_settings WHERE tenant_id = ?`)
      .get(tenantId) as WorkspaceSettingsRow | undefined;
    if (!row) {
      return {
        tenantId,
        defaultReviewMode: 'normal',
        autoApplyDefault: false,
        minConfidence: 0.6,
        maxComments: 8,
        autoEnableNewRepos: true,
        updatedAt: new Date().toISOString(),
      };
    }
    return mapWorkspaceSettings(row);
  }

  updateWorkspaceSettings(tenantId: string, patch: Partial<Omit<WorkspaceSettings, 'tenantId' | 'updatedAt'>>): WorkspaceSettings {
    const current = this.getWorkspaceSettings(tenantId);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `INSERT INTO workspace_settings
         (tenant_id, default_review_mode, auto_apply_default, min_confidence, max_comments, auto_enable_new_repos, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           default_review_mode = excluded.default_review_mode,
           auto_apply_default = excluded.auto_apply_default,
           min_confidence = excluded.min_confidence,
           max_comments = excluded.max_comments,
           auto_enable_new_repos = excluded.auto_enable_new_repos,
           updated_at = excluded.updated_at`,
      )
      .run(
        tenantId,
        next.defaultReviewMode,
        next.autoApplyDefault ? 1 : 0,
        next.minConfidence,
        next.maxComments,
        next.autoEnableNewRepos ? 1 : 0,
        new Date().toISOString(),
      );
    return this.getWorkspaceSettings(tenantId);
  }

  close(): void {
    this.db.close();
  }
}

interface RepoRow {
  id: string;
  installation_id: number;
  tenant_id: string;
  github_repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  private: number;
  default_branch: string | null;
  enabled: number;
  review_mode: string;
  auto_apply: number;
  review_on_open: number;
  review_on_push: number;
  added_at: string;
  updated_at: string;
}

function mapRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    installationId: r.installation_id,
    tenantId: r.tenant_id,
    githubRepoId: r.github_repo_id,
    owner: r.owner,
    name: r.name,
    fullName: r.full_name,
    private: Boolean(r.private),
    defaultBranch: r.default_branch ?? undefined,
    enabled: Boolean(r.enabled),
    reviewMode: r.review_mode === 'strict' ? 'strict' : 'normal',
    autoApply: Boolean(r.auto_apply),
    // Existing DBs default both to true via the migration (matches the old
    // single `enabled` toggle's behavior), so nothing changes until a user
    // explicitly flips one off in the dashboard.
    reviewOnOpen: Boolean(r.review_on_open ?? 1),
    reviewOnPush: Boolean(r.review_on_push ?? 1),
    addedAt: r.added_at,
    updatedAt: r.updated_at,
  };
}

interface PullRequestRow {
  id: string;
  tenant_id: string;
  installation_id: number;
  repo_full_name: string;
  number: number;
  title: string;
  author: string;
  state: string;
  draft: number;
  head_sha: string;
  url: string | null;
  open_findings: number;
  opened_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  last_reviewed_at: string | null;
  updated_at: string;
}

function mapPullRequest(r: PullRequestRow): PullRequest {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    installationId: r.installation_id,
    repoFullName: r.repo_full_name,
    number: r.number,
    title: r.title,
    author: r.author,
    state: r.state as PullRequestState,
    draft: Boolean(r.draft),
    headSha: r.head_sha,
    url: r.url ?? undefined,
    openFindings: r.open_findings,
    openedAt: r.opened_at ?? undefined,
    closedAt: r.closed_at ?? undefined,
    mergedAt: r.merged_at ?? undefined,
    lastReviewedAt: r.last_reviewed_at ?? undefined,
    updatedAt: r.updated_at,
  };
}

interface FindingRow {
  id: string;
  tenant_id: string;
  installation_id: number;
  repo_full_name: string;
  pr_number: number;
  fingerprint: string;
  file: string;
  line: number | null;
  severity: string;
  category: string;
  message: string;
  status: string;
  rule_id: string;
  github_comment_id: number | null;
  first_seen_sha: string;
  fixed_at_sha: string | null;
  created_at: string;
  updated_at: string;
}

function mapFinding(r: FindingRow): FindingRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    installationId: r.installation_id,
    repoFullName: r.repo_full_name,
    prNumber: r.pr_number,
    fingerprint: r.fingerprint,
    file: r.file,
    line: r.line ?? undefined,
    severity: r.severity,
    category: r.category,
    message: r.message,
    status: r.status as FindingStatus,
    ruleId: r.rule_id,
    githubCommentId: r.github_comment_id ?? undefined,
    firstSeenSha: r.first_seen_sha,
    fixedAtSha: r.fixed_at_sha ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface WorkspaceSettingsRow {
  tenant_id: string;
  default_review_mode: string;
  auto_apply_default: number;
  min_confidence: number;
  max_comments: number;
  auto_enable_new_repos: number;
  updated_at: string;
}

function mapWorkspaceSettings(r: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    tenantId: r.tenant_id,
    defaultReviewMode: r.default_review_mode === 'strict' ? 'strict' : 'normal',
    autoApplyDefault: Boolean(r.auto_apply_default),
    minConfidence: r.min_confidence,
    maxComments: r.max_comments,
    autoEnableNewRepos: Boolean(r.auto_enable_new_repos),
    updatedAt: r.updated_at,
  };
}

interface UserRow {
  id: string;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
  google_id?: string | null;
  is_superadmin: number;
  created_at: string;
}

function syntheticUserId(seed: string): number {
  // Deterministic negative github_id for non-GitHub (password / Google) users —
  // real GitHub ids are positive, so negatives never collide with them. Uses 48
  // bits of a sha256 (well within JS safe-integer and SQLite's 64-bit INTEGER):
  // birthday collisions only near ~2^24 (~16M) users, vs the old 31-bit string
  // hash which collided at ~54k and broke email/Google signups at that scale.
  const n = createHash('sha256').update(seed).digest().readUIntBE(0, 6); // 48-bit
  return -(n || 1);
}

interface SecurityFactorRow {
  totp_enabled: number;
  last_totp_epoch: number | null;
  recovery_code_hashes_json: string;
}

interface ChallengeFactorRow extends SecurityFactorRow {
  id: string;
  user_id: string;
  next: string;
  expires_at: string;
  created_at: string;
}

function validTotpEpoch(epoch: number): boolean {
  return Number.isSafeInteger(epoch) && epoch >= 0;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    name: row.name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    email: row.email ?? undefined,
    isSuperAdmin: Boolean(row.is_superadmin),
    createdAt: row.created_at,
  };
}

/** Stable 31-bit int hash of a string (for synthetic github ids). */
/** Stripe subscription statuses that revoke paid access (dunning / failed / ended). */
const DOWNGRADED_SUB_STATUSES = new Set(['past_due', 'unpaid', 'canceled', 'incomplete_expired']);

interface ReviewRunRow {
  id: string;
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr: number;
  head_sha: string;
  action: string;
  status: string;
  skip_reason: string | null;
  error: string | null;
  duration_ms: number;
  findings_new: number;
  findings_fixed: number;
  findings_open: number;
  cost_usd: number;
  deep: number;
  created_at: string;
}

function mapReviewRun(row: ReviewRunRow): ReviewRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    owner: row.owner,
    repo: row.repo,
    pr: row.pr,
    headSha: row.head_sha,
    action: row.action,
    status: row.status as ReviewRunStatus,
    skipReason: row.skip_reason ?? undefined,
    error: row.error ?? undefined,
    durationMs: row.duration_ms,
    findingsNew: row.findings_new,
    findingsFixed: row.findings_fixed,
    findingsOpen: row.findings_open,
    costUsd: row.cost_usd ?? 0,
    deep: row.deep === 1,
    createdAt: row.created_at,
  };
}

let sharedDb: AppDatabase | null = null;

export function createAppDatabase(): AppDatabase {
  if (!sharedDb) {
    sharedDb = new AppDatabase(process.env.STORE_PATH ?? defaultDbPath());
  }
  return sharedDb;
}

function defaultDbPath(): string {
  const dataDir = path.join(process.cwd(), '.data');
  const legacy = path.join(dataDir, 'velatrix-review.db');
  const current = path.join(dataDir, 'orvex-review.db');
  // keep using a pre-rename database if it's the only one present
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  return current;
}

/** @deprecated use createAppDatabase */
export function createReviewStore(): AppDatabase {
  return createAppDatabase();
}

export type SqliteReviewStore = AppDatabase;
