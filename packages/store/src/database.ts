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
  manual_review_json TEXT,
  PRIMARY KEY (installation_id, owner, repo, pr)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  email TEXT,
  email_verified_at TEXT,
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
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'skipped', 'failed')),
  skip_reason TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  findings_new INTEGER NOT NULL DEFAULT 0 CHECK (findings_new >= 0),
  findings_fixed INTEGER NOT NULL DEFAULT 0 CHECK (findings_fixed >= 0),
  findings_open INTEGER NOT NULL DEFAULT 0 CHECK (findings_open >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  deep INTEGER NOT NULL DEFAULT 0 CHECK (deep IN (0, 1)),
  free_tier INTEGER NOT NULL DEFAULT 0 CHECK (free_tier IN (0, 1)),
  new_findings_json TEXT,
  worker_id TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_tenant_time ON review_runs(tenant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_id_tenant ON review_runs(id, tenant_id);
-- Every billing check runs countAccountReviews (owner-scoped, lower(owner)) up
-- to 3× per review; this expression index keeps it off a full table scan as the
-- table grows. IF NOT EXISTS + always-run schema → created on existing DBs too.
CREATE INDEX IF NOT EXISTS idx_runs_owner_lower ON review_runs(lower(owner), status, created_at);

CREATE TABLE IF NOT EXISTS review_run_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  pass_name TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  input_rate_per_m REAL NOT NULL DEFAULT 0 CHECK (input_rate_per_m >= 0),
  output_rate_per_m REAL NOT NULL DEFAULT 0 CHECK (output_rate_per_m >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  token_source TEXT NOT NULL DEFAULT 'unknown',
  attempt_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, tenant_id) REFERENCES review_runs(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_usage_run ON review_run_usage(run_id);
CREATE INDEX IF NOT EXISTS idx_run_usage_tenant_time ON review_run_usage(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_usage_model_time ON review_run_usage(model, created_at);

CREATE TABLE IF NOT EXISTS review_run_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  parent_attempt_id TEXT REFERENCES review_run_attempts(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  pass_name TEXT,
  transport TEXT NOT NULL CHECK (transport IN ('responses', 'chat', 'anthropic', 'codex-cli')),
  retry_index INTEGER NOT NULL DEFAULT 0 CHECK (retry_index >= 0),
  key_index INTEGER NOT NULL DEFAULT 0 CHECK (key_index >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'rate_limited')),
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (run_id, tenant_id) REFERENCES review_runs(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_attempts_run ON review_run_attempts(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_run_attempts_provider_time ON review_run_attempts(provider, started_at);

CREATE TABLE IF NOT EXISTS stripe_revenue_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  invoice_id TEXT,
  tenant_id TEXT,
  customer_id TEXT,
  subscription_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A charge can receive multiple partial refunds. Keep invoice-paid events
-- idempotent by invoice/type, while event_id remains the dedupe key for every
-- refund delta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_revenue_invoice_paid
  ON stripe_revenue_events(invoice_id, event_type)
  WHERE invoice_id IS NOT NULL AND event_type = 'invoice.paid';
CREATE INDEX IF NOT EXISTS idx_stripe_revenue_tenant_time
  ON stripe_revenue_events(tenant_id, occurred_at);

CREATE TABLE IF NOT EXISTS stripe_meter_events (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  plan TEXT NOT NULL,
  units INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  reported_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stripe_meter_pending
  ON stripe_meter_events(status, next_attempt_at);

-- Prepaid overage wallet: positive rows are top-ups (Stripe payment), negative
-- rows are review debits. Balance = SUM(amount_cents). Top-ups are unique by
-- stripe_session_id; per-run debits are unique by run_id so a retry cannot
-- double-charge the wallet.
CREATE TABLE IF NOT EXISTS tenant_credit_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT,
  stripe_session_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON tenant_credit_ledger(tenant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_stripe_session
  ON tenant_credit_ledger(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_run_debit
  ON tenant_credit_ledger(run_id) WHERE run_id IS NOT NULL AND amount_cents < 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_run_refund
  ON tenant_credit_ledger(run_id) WHERE run_id IS NOT NULL AND kind = 'overage_refund';

CREATE TABLE IF NOT EXISTS platform_costs (
  category TEXT PRIMARY KEY,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TEXT NOT NULL
);

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

-- Durable webhook claims prevent duplicate Stripe state transitions and
-- duplicate GitHub command jobs across process restarts and workers. Unfinished
-- claims can be reclaimed after the caller's stale window.
CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  claim_token TEXT,
  processed_at TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON webhook_events(processed_at);

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
  private readonly workerId = process.env.ORVEX_WORKER_ID?.trim() || `${process.pid}:${randomUUID()}`;

  constructor(dbPath: string) {
    const resolvedDbPath = path.resolve(dbPath);
    const checkoutRoot = path.resolve(process.env.ORVEX_CHECKOUT_ROOT ?? process.cwd());
    const relativeToCheckout = path.relative(checkoutRoot, resolvedDbPath);
    const insideCheckout =
      relativeToCheckout === '' ||
      (!relativeToCheckout.startsWith(`..${path.sep}`) &&
        relativeToCheckout !== '..' &&
        !path.isAbsolute(relativeToCheckout));
    if (
      (process.env.NODE_ENV === 'production' || process.env.ORVEX_REQUIRE_DURABLE_STORAGE === '1') &&
      (!path.isAbsolute(dbPath) || insideCheckout || dbPath.includes(`${path.sep}.data${path.sep}`))
    ) {
      throw new Error(`durable production STORE_PATH must be an absolute path outside the checkout: ${dbPath}`);
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    // Multi-process writers (docs allow scaling workers on one SQLite file) wait
    // briefly on SQLITE_BUSY instead of failing the quota/lock update.
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA_V2);
    this.migrateLegacyPrReviews();
    this.migrateUserAuthColumns();
    this.migrateUserSecurityColumns();
    this.migrateTenantPlan();
    this.migrateTenantBillingColumns();
    this.migratePrepaidCreditLedger();
    this.migrateRepoAutomationToggles();
    this.migrateReviewRunCostColumns();
    this.migrateReviewRunLifecycleColumns();
    this.migratePrReviewColumns();
    this.migrateRevenueIndexes();
    this.migrateWebhookEventColumns();
  }

  /** Add later pr_reviews columns (codex thread id, manual-review candidates) to existing DBs. */
  private migratePrReviewColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(pr_reviews)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('codex_thread_id')) {
      this.db.exec(`ALTER TABLE pr_reviews ADD COLUMN codex_thread_id TEXT`);
    }
    // Manual-review candidates, kept apart from findings_json because they are
    // UNCONFIRMED and must not reach the dashboard projection or the
    // new/open/fixed stats. Stored solely so `@orvex ignore <file>:<line>` can
    // resolve a candidate that has no inline comment to reply to.
    if (!names.has('manual_review_json')) {
      this.db.exec(`ALTER TABLE pr_reviews ADD COLUMN manual_review_json TEXT`);
    }
  }

  private migrateRevenueIndexes(): void {
    // Invoice payments are naturally one-per-invoice, but a charge can emit
    // multiple partial-refund events. The old index treated both as one shape
    // and discarded later refunds with INSERT OR IGNORE.
    this.db.exec(`DROP INDEX IF EXISTS idx_stripe_revenue_invoice_type`);
    this.db.exec(`DROP INDEX IF EXISTS idx_stripe_revenue_invoice_paid`);
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_revenue_invoice_paid
       ON stripe_revenue_events(invoice_id, event_type)
       WHERE invoice_id IS NOT NULL AND event_type = 'invoice.paid'`,
    );
  }

  /** Add fencing tokens so a timed-out worker cannot complete a claim that a
   * newer worker has reclaimed. */
  private migrateWebhookEventColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(webhook_events)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'claim_token')) {
      this.db.exec(`ALTER TABLE webhook_events ADD COLUMN claim_token TEXT`);
    }
    this.db.exec(
      `UPDATE webhook_events SET claim_token = lower(hex(randomblob(16)))
       WHERE claim_token IS NULL OR claim_token = ''`,
    );
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

  /** Lifecycle fields and database-enforced integrity for databases created
   * before review_runs gained native CHECK/FK clauses. SQLite cannot add those
   * clauses with ALTER TABLE, so equivalent aborting triggers protect upgraded
   * installations while fresh databases use the declarations in SCHEMA_V2. */
  private migrateReviewRunLifecycleColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(review_runs)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('worker_id')) this.db.exec(`ALTER TABLE review_runs ADD COLUMN worker_id TEXT`);
    if (!names.has('heartbeat_at')) this.db.exec(`ALTER TABLE review_runs ADD COLUMN heartbeat_at TEXT`);
    if (!names.has('completed_at')) this.db.exec(`ALTER TABLE review_runs ADD COLUMN completed_at TEXT`);
    this.db.exec(`
UPDATE review_runs
SET completed_at = created_at
WHERE status <> 'running' AND completed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_id_tenant ON review_runs(id, tenant_id);

CREATE TRIGGER IF NOT EXISTS trg_review_runs_tenant_insert
BEFORE INSERT ON review_runs
WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'review_runs tenant foreign key violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_runs_tenant_update
BEFORE UPDATE OF tenant_id ON review_runs
WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'review_runs tenant foreign key violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_runs_check_insert
BEFORE INSERT ON review_runs
WHEN NEW.status NOT IN ('running','completed','skipped','failed')
  OR NEW.duration_ms < 0 OR NEW.findings_new < 0 OR NEW.findings_fixed < 0
  OR NEW.findings_open < 0 OR NEW.input_tokens < 0 OR NEW.output_tokens < 0
  OR NEW.cost_usd < 0 OR NEW.deep NOT IN (0,1) OR NEW.free_tier NOT IN (0,1)
BEGIN SELECT RAISE(ABORT, 'review_runs check constraint violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_runs_check_update
BEFORE UPDATE ON review_runs
WHEN NEW.status NOT IN ('running','completed','skipped','failed')
  OR NEW.duration_ms < 0 OR NEW.findings_new < 0 OR NEW.findings_fixed < 0
  OR NEW.findings_open < 0 OR NEW.input_tokens < 0 OR NEW.output_tokens < 0
  OR NEW.cost_usd < 0 OR NEW.deep NOT IN (0,1) OR NEW.free_tier NOT IN (0,1)
BEGIN SELECT RAISE(ABORT, 'review_runs check constraint violation'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_usage_parent_insert
BEFORE INSERT ON review_run_usage
WHEN NOT EXISTS (
  SELECT 1 FROM review_runs WHERE id = NEW.run_id AND tenant_id = NEW.tenant_id
)
BEGIN SELECT RAISE(ABORT, 'review_run_usage foreign key violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_usage_check_insert
BEFORE INSERT ON review_run_usage
WHEN NEW.input_tokens < 0 OR NEW.output_tokens < 0 OR NEW.input_rate_per_m < 0
  OR NEW.output_rate_per_m < 0 OR NEW.cost_usd < 0
BEGIN SELECT RAISE(ABORT, 'review_run_usage check constraint violation'); END;
`);
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

  /** Prepaid overage wallet — CREATE IF NOT EXISTS is enough for existing DBs. */
  private migratePrepaidCreditLedger(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS tenant_credit_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT,
  stripe_session_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON tenant_credit_ledger(tenant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_stripe_session
  ON tenant_credit_ledger(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_run_debit
  ON tenant_credit_ledger(run_id) WHERE run_id IS NOT NULL AND amount_cents < 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_run_refund
  ON tenant_credit_ledger(run_id) WHERE run_id IS NOT NULL AND kind = 'overage_refund';
`);
  }

  /** Current prepaid overage balance in USD cents (can be 0, never negative in normal use). */
  getCreditBalanceCents(tenantId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM tenant_credit_ledger WHERE tenant_id = ?`)
      .get(tenantId) as { n: number };
    return Number(row.n) || 0;
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
    if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
      throw new Error('credit top-up amount must be a positive integer (cents)');
    }
    const amount = Math.floor(input.amountCents);
    const existing = this.db
      .prepare(`SELECT id FROM tenant_credit_ledger WHERE stripe_session_id = ?`)
      .get(input.stripeSessionId) as { id: string } | undefined;
    if (existing) {
      return { applied: false, balanceCents: this.getCreditBalanceCents(input.tenantId) };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
         VALUES (?, ?, ?, 'topup', NULL, ?, ?, ?)`,
      )
      .run(id, input.tenantId, amount, input.stripeSessionId, input.note ?? null, now);
    return { applied: true, balanceCents: this.getCreditBalanceCents(input.tenantId) };
  }

  /**
   * Debit prepaid overage for a review run. Returns false when the balance is
   * insufficient. Unique on run_id so a second debit for the same run is a no-op success.
   */
  debitOverageCredits(tenantId: string, runId: string, amountCents: number, note?: string): boolean {
    if (!Number.isFinite(amountCents) || amountCents <= 0) return true;
    const amount = Math.floor(amountCents);
    const prior = this.db
      .prepare(`SELECT id FROM tenant_credit_ledger WHERE run_id = ? AND amount_cents < 0`)
      .get(runId) as { id: string } | undefined;
    if (prior) return true;
    const balance = this.getCreditBalanceCents(tenantId);
    if (balance < amount) return false;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
         VALUES (?, ?, ?, 'overage_debit', ?, NULL, ?, ?)`,
      )
      .run(id, tenantId, -amount, runId, note ?? null, now);
    return true;
  }

  /** Net prepaid debit still held for a run (debit minus any refunds/adjustments). */
  overageDebitNetCents(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM tenant_credit_ledger WHERE run_id = ?`,
      )
      .get(runId) as { n: number };
    // Debits are negative; net held = -sum when sum < 0.
    return Math.max(0, -(Number(row.n) || 0));
  }

  /** Refund a prepaid overage debit when the review was skipped before provider spend. */
  refundOverageCredits(runId: string, note?: string): boolean {
    return this.db
      .transaction(() => {
        const debit = this.db
          .prepare(
            `SELECT id, tenant_id, amount_cents FROM tenant_credit_ledger
             WHERE run_id = ? AND kind = 'overage_debit' AND amount_cents < 0`,
          )
          .get(runId) as { id: string; tenant_id: string; amount_cents: number } | undefined;
        if (!debit) return false;
        const already = this.db
          .prepare(
            `SELECT id FROM tenant_credit_ledger WHERE run_id = ? AND kind = 'overage_refund'`,
          )
          .get(runId) as { id: string } | undefined;
        if (already) return false;
        const net = this.overageDebitNetCents(runId);
        if (net <= 0) return false;
        const id = randomUUID();
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
             VALUES (?, ?, ?, 'overage_refund', ?, NULL, ?, ?)`,
          )
          .run(id, debit.tenant_id, net, runId, note ?? 'refund unused overage reservation', now);
        return true;
      })
      .immediate();
  }

  /**
   * After delivery, reduce a reserved deep (2×) debit to the units actually
   * delivered. Idempotent via kind=overage_partial_refund uniqueness per run.
   */
  reconcileOverageDebit(runId: string, correctDebitCents: number, note?: string): boolean {
    const correct = Math.max(0, Math.floor(correctDebitCents));
    return this.db
      .transaction(() => {
        const debit = this.db
          .prepare(
            `SELECT tenant_id FROM tenant_credit_ledger
             WHERE run_id = ? AND kind = 'overage_debit' AND amount_cents < 0`,
          )
          .get(runId) as { tenant_id: string } | undefined;
        if (!debit) return false;
        const priorPartial = this.db
          .prepare(
            `SELECT id FROM tenant_credit_ledger WHERE run_id = ? AND kind = 'overage_partial_refund'`,
          )
          .get(runId) as { id: string } | undefined;
        if (priorPartial) return false;
        const net = this.overageDebitNetCents(runId);
        if (net <= correct) return false;
        const delta = net - correct;
        const id = randomUUID();
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
             VALUES (?, ?, ?, 'overage_partial_refund', ?, NULL, ?, ?)`,
          )
          .run(id, debit.tenant_id, delta, runId, note ?? 'reconcile overage to delivered units', now);
        return true;
      })
      .immediate();
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
    const requested = Math.max(0, Math.floor(input.amountCents));
    if (requested <= 0) {
      return { applied: false, clawedCents: 0, balanceCents: this.getCreditBalanceCents(input.tenantId) };
    }
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(`SELECT id FROM tenant_credit_ledger WHERE stripe_session_id = ?`)
          .get(input.stripeSessionId) as { id: string } | undefined;
        if (existing) {
          return {
            applied: false,
            clawedCents: 0,
            balanceCents: this.getCreditBalanceCents(input.tenantId),
          };
        }
        const balance = this.getCreditBalanceCents(input.tenantId);
        const clawed = Math.min(balance, requested);
        if (clawed <= 0) {
          // Still record a zero-effect marker? Skip — leave Stripe retries able to
          // apply later if a top-up lands first. Use a sentinel row with 0? No —
          // without a row retries re-enter. Record a 0-amount marker via note-only
          // is invalid (CHECK). Insert -0 meaningless. Insert kind with 0 cents:
          this.db
            .prepare(
              `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
               VALUES (?, ?, 0, 'topup_clawback', NULL, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              input.tenantId,
              input.stripeSessionId,
              input.note ?? 'refund clawback (no unused balance)',
              new Date().toISOString(),
            );
          return { applied: true, clawedCents: 0, balanceCents: balance };
        }
        this.db
          .prepare(
            `INSERT INTO tenant_credit_ledger (id, tenant_id, amount_cents, kind, run_id, stripe_session_id, note, created_at)
             VALUES (?, ?, ?, 'topup_clawback', NULL, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.tenantId,
            -clawed,
            input.stripeSessionId,
            input.note ?? 'Stripe refund clawback',
            new Date().toISOString(),
          );
        return {
          applied: true,
          clawedCents: clawed,
          balanceCents: this.getCreditBalanceCents(input.tenantId),
        };
      })
      .immediate();
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
   * Counts 'running', 'completed', AND 'failed' so that concurrently in-flight
   * reviews see each other AND a post-spend failure cannot refund a trial/hourly
   * credit (farmers used to induce failures after LLM burn to reset the cap).
   * A 'skipped' run is NOT counted (blocked before work / no LLM). `fix:*` /
   * `cmd:%` runs are excluded; only reviews count.
   */
  countAccountReviews(owner: string, opts: { sinceMs?: number } = {}): number {
    const params: unknown[] = [owner];
    // Exclude fix commits ('fix:%'), scans, and interactive commands ('cmd:%') — only
    // actual reviews count toward the trial/hourly/monthly review caps.
    let where =
      "lower(owner) = lower(?) AND (status IN ('running', 'completed', 'failed') OR (status = 'skipped' AND skip_reason LIKE 'interrupted by restart%')) AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%'";
    if (opts.sinceMs !== undefined) {
      where += ' AND created_at >= ?';
      params.push(new Date(Date.now() - opts.sinceMs).toISOString());
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM review_runs WHERE ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  countRunningAccountReviews(owner: string, sinceMs = 30 * 24 * 3_600_000): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM review_runs
         WHERE lower(owner) = lower(?) AND status = 'running' AND created_at >= ?
           AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%'`,
      )
      .get(owner, since) as { n: number };
    return row.n;
  }

  /**
   * In-flight rows that reserve COGS headroom — includes scans and interactive
   * commands so a stampede cannot under-reserve the monthly dollar ceiling.
   */
  countRunningCogsReservations(owner: string, sinceMs = 30 * 24 * 3_600_000): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM review_runs
         WHERE lower(owner) = lower(?) AND status = 'running' AND created_at >= ?`,
      )
      .get(owner, since) as { n: number };
    return row.n;
  }

  /**
   * Tenant-scoped review UNITS in the rolling window (deep=2, normal=1), same
   * status filter as countAccountReviews. Used for paid included/hard/prepaid
   * gates so wallets are not drained by another workspace's owner history.
   */
  countTenantReviewUnits(tenantId: string, opts: { sinceMs?: number } = {}): number {
    const params: unknown[] = [tenantId];
    let where =
      "tenant_id = ? AND (status IN ('running', 'completed', 'failed') OR (status = 'skipped' AND skip_reason LIKE 'interrupted by restart%')) AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%'";
    if (opts.sinceMs !== undefined) {
      where += ' AND created_at >= ?';
      params.push(new Date(Date.now() - opts.sinceMs).toISOString());
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN deep = 1 THEN 2 ELSE 1 END), 0) AS n FROM review_runs WHERE ${where}`,
      )
      .get(...params) as { n: number };
    return Number(row.n) || 0;
  }

  /**
   * Oldest `created_at` among account reviews in the rolling window — used to
   * tell users when the next hourly slot frees (that review ages out of the
   * window). Same filter as `countAccountReviews`.
   */
  oldestAccountReviewCreatedAt(owner: string, sinceMs: number): string | null {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT created_at FROM review_runs
         WHERE lower(owner) = lower(?) AND (status IN ('running', 'completed', 'failed') OR (status = 'skipped' AND skip_reason LIKE 'interrupted by restart%'))
           AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%'
           AND created_at >= ?
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(owner, since) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  countTenantCompletedReviewsSince(tenantId: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE tenant_id = ? AND status = 'completed'
           AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%'
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
           AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%'
           AND created_at >= ?`,
      )
      .get(tenantId, sinceIso) as { n: number };
    return row.n;
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
    const row = this.db
      .prepare(
        `WITH target AS (
           SELECT id, created_at
           FROM review_runs
           WHERE id = ? AND tenant_id = ?
         )
         SELECT
           COALESCE((
             SELECT SUM(CASE WHEN r.deep = 1 THEN 2 ELSE 1 END)
             FROM review_runs r, target t
             WHERE r.tenant_id = ? AND r.status = 'completed'
               AND r.action NOT LIKE 'fix:%' AND r.action NOT LIKE 'cmd:%' AND r.action NOT LIKE 'scan:%'
               AND r.created_at >= ?
               AND (r.created_at < t.created_at OR (r.created_at = t.created_at AND r.id < t.id))
           ), 0) AS units_before,
           COALESCE((
             SELECT SUM(CASE WHEN r.deep = 1 THEN 2 ELSE 1 END)
             FROM review_runs r, target t
             WHERE r.tenant_id = ? AND r.status = 'completed'
               AND r.action NOT LIKE 'fix:%' AND r.action NOT LIKE 'cmd:%' AND r.action NOT LIKE 'scan:%'
               AND r.created_at >= ?
               AND (r.created_at < t.created_at OR (r.created_at = t.created_at AND r.id <= t.id))
           ), 0) AS units_through
         FROM target`,
      )
      .get(runId, tenantId, tenantId, sinceIso, tenantId, sinceIso) as
      | { units_before: number; units_through: number }
      | undefined;
    return row ? { unitsBefore: row.units_before, unitsThrough: row.units_through } : null;
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
           AND status = 'completed' AND action NOT LIKE 'fix:%' AND action NOT LIKE 'scan:%'
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

  /**
   * Claim a webhook delivery atomically across workers. A processed delivery is
   * permanent until retention; an unfinished claim may be reclaimed after the
   * stale window when a process died mid-handler.
   */
  claimWebhookEvent(provider: string, eventId: string, staleMs = 15 * 60_000): string | null {
    const claimedAt = new Date().toISOString();
    const claimToken = randomUUID();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_events (provider, event_id, claimed_at, claim_token, processed_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(provider, eventId, claimedAt, claimToken);
    if (inserted.changes > 0) return claimToken;

    const existing = this.db
      .prepare(`SELECT claimed_at, claim_token, processed_at FROM webhook_events WHERE provider = ? AND event_id = ?`)
      .get(provider, eventId) as { claimed_at: string; claim_token: string | null; processed_at: string | null } | undefined;
    if (!existing || existing.processed_at) return null;
    const claimedTime = Date.parse(existing.claimed_at);
    if (Number.isFinite(claimedTime) && Date.now() - claimedTime < staleMs) return null;

    const reclaimed = this.db
      .prepare(
        `UPDATE webhook_events
         SET claimed_at = ?, claim_token = ?
         WHERE provider = ? AND event_id = ? AND processed_at IS NULL AND claimed_at = ?`,
      )
      .run(claimedAt, claimToken, provider, eventId, existing.claimed_at);
    return reclaimed.changes > 0 ? claimToken : null;
  }

  getWebhookEvent(
    provider: string,
    eventId: string,
  ): { claimedAt: string; processedAt?: string } | null {
    const row = this.db
      .prepare(`SELECT claimed_at, processed_at FROM webhook_events WHERE provider = ? AND event_id = ?`)
      .get(provider, eventId) as { claimed_at: string; processed_at: string | null } | undefined;
    if (!row) return null;
    return {
      claimedAt: row.claimed_at,
      processedAt: row.processed_at ?? undefined,
    };
  }

  completeWebhookEvent(provider: string, eventId: string, claimToken: string): void {
    this.db
      .prepare(
        `UPDATE webhook_events
         SET processed_at = ?
         WHERE provider = ? AND event_id = ? AND claim_token = ? AND processed_at IS NULL`,
      )
      .run(new Date().toISOString(), provider, eventId, claimToken);
  }

  releaseWebhookEvent(provider: string, eventId: string, claimToken: string): void {
    this.db
      .prepare(
        `DELETE FROM webhook_events
         WHERE provider = ? AND event_id = ? AND claim_token = ? AND processed_at IS NULL`,
      )
      .run(provider, eventId, claimToken);
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
    if (!bodyHash || bodyHash.length > 128) return null;
    const bodyProvider = `${provider}-body`;
    const ttlMs =
      Number.isFinite(opts.ttlMs) && (opts.ttlMs as number) > 0
        ? Math.min(Math.floor(opts.ttlMs as number), 7 * 24 * 3600_000)
        : 2 * 3600_000;
    const staleMs =
      Number.isFinite(opts.staleMs) && (opts.staleMs as number) > 0
        ? Math.min(Math.floor(opts.staleMs as number), 24 * 3600_000)
        : 15 * 60_000;

    const claimedAt = new Date().toISOString();
    const claimToken = randomUUID();

    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT claimed_at, claim_token, processed_at FROM webhook_events WHERE provider = ? AND event_id = ?`,
        )
        .get(bodyProvider, bodyHash) as
        | { claimed_at: string; claim_token: string | null; processed_at: string | null }
        | undefined;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO webhook_events (provider, event_id, claimed_at, claim_token, processed_at)
             VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(bodyProvider, bodyHash, claimedAt, claimToken);
        return claimToken;
      }

      const anchor = existing.processed_at ?? existing.claimed_at;
      const anchorMs = Date.parse(anchor);
      const age = Number.isFinite(anchorMs) ? Date.now() - anchorMs : 0;

      if (existing.processed_at) {
        // Still inside the replay window — reject as duplicate.
        if (age < ttlMs) return null;
        // TTL elapsed: drop the stale hash so a legitimate identical payload
        // (or a later attack outside the window) can claim fresh.
        this.db
          .prepare(`DELETE FROM webhook_events WHERE provider = ? AND event_id = ?`)
          .run(bodyProvider, bodyHash);
        this.db
          .prepare(
            `INSERT INTO webhook_events (provider, event_id, claimed_at, claim_token, processed_at)
             VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(bodyProvider, bodyHash, claimedAt, claimToken);
        return claimToken;
      }

      // In-flight claim: allow reclaim only after the stale window (crashed worker).
      if (age < staleMs) return null;
      const reclaimed = this.db
        .prepare(
          `UPDATE webhook_events
           SET claimed_at = ?, claim_token = ?
           WHERE provider = ? AND event_id = ? AND processed_at IS NULL AND claimed_at = ?`,
        )
        .run(claimedAt, claimToken, bodyProvider, bodyHash, existing.claimed_at);
      return reclaimed.changes > 0 ? claimToken : null;
    })();
  }

  /** Provider key used by claimWebhookBodyHash for lookups/complete/release. */
  webhookBodyProvider(provider: string): string {
    return `${provider}-body`;
  }

  /** Cheap liveness probe for /ready — throws if the DB is unreachable/locked. */
  pingDb(): void {
    this.db.prepare('SELECT 1').get();
  }

  /** Clear only rows whose durable heartbeat is stale. A second worker process
   * must never interrupt a peer's live review during a rolling start. */
  failStaleRunningRuns(opts: { staleAfterMs?: number; nowMs?: number } = {}): number {
    const staleAfterMs = Math.max(60_000, opts.staleAfterMs ?? 15 * 60_000);
    const nowMs = opts.nowMs ?? Date.now();
    const cutoff = new Date(nowMs - staleAfterMs).toISOString();
    const res = this.db
      .prepare(
        `UPDATE review_runs
         SET status = 'skipped', skip_reason = 'interrupted by restart — retried',
             completed_at = ?, worker_id = NULL
         WHERE status = 'running' AND COALESCE(heartbeat_at, created_at) < ?`,
      )
      .run(new Date(nowMs).toISOString(), cutoff);
    return res.changes;
  }

  heartbeatReviewRun(id: string): boolean {
    if (!id) return false;
    return this.db
      .prepare(
        `UPDATE review_runs SET heartbeat_at = ?
         WHERE id = ? AND status = 'running' AND worker_id = ?`,
      )
      .run(new Date().toISOString(), id, this.workerId).changes > 0;
  }

  /**
   * Atomically mark a still-running review as interrupted so a graceful
   * shutdown requeue can resume the SAME row via resumeReviewRun (no second
   * trial/hourly slot). Returns true when the row was still running.
   */
  interruptReviewRun(id: string): boolean {
    if (!id) return false;
    return this.db
      .transaction(() => {
        const res = this.db
          .prepare(
            `UPDATE review_runs
             SET status = 'skipped', skip_reason = 'interrupted by restart — retried',
                 completed_at = ?, worker_id = NULL
             WHERE id = ? AND status = 'running'`,
          )
          .run(new Date().toISOString(), id);
        if (res.changes > 0) {
          // Wallet debit stays until resume completes or is abandoned; resume
          // reuses this run id so a second debit is not charged.
        }
        return res.changes > 0;
      })
      .immediate();
  }

  /**
   * Bounded retention. Deletes only EPHEMERAL rows — never 'completed' or
   * 'failed' reviews. Lifetime trial counts running+completed+failed forever
   * (anti-farm); pruning `failed` after 30d refunded the trial. Only `skipped`
   * cooldown/limit/misfire rows are ephemeral. Also clears expired sessions and
   * old abuse signals. Safe to run on a schedule.
   */
  pruneEphemeralData(opts: { runRetentionMs?: number; abuseRetentionMs?: number } = {}): number {
    const runCutoff = new Date(Date.now() - (opts.runRetentionMs ?? 30 * 24 * 3_600_000)).toISOString();
    const abuseCutoff = new Date(Date.now() - (opts.abuseRetentionMs ?? 90 * 24 * 3_600_000)).toISOString();
    const webhookCutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
    // Body-hash replay keys only need to outlive the capture→replay window.
    // Keep them shorter than delivery ids so identical tiny payloads (ping `{}`)
    // are not blocked for the full 30-day event retention.
    const bodyHashCutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
    const now = new Date().toISOString();
    let n = 0;
    n += this.db.transaction(() => {
      // review_run_usage predates a foreign-key relationship to review_runs;
      // remove its rows explicitly or old interrupted attempts keep inflating
      // the profitability dashboard after their parent run is pruned.
      const usage = this.db
        .prepare(
          `DELETE FROM review_run_usage
           WHERE run_id IN (
             SELECT id FROM review_runs
             WHERE status = 'skipped' AND created_at < ?
           )`,
        )
        .run(runCutoff).changes;
      const runs = this.db
        .prepare(`DELETE FROM review_runs WHERE status = 'skipped' AND created_at < ?`)
        .run(runCutoff).changes;
      // Remove orphaned overage ledger rows only when their net is already zero
      // (debit + refund). Never delete a lone debit — that would inflate balance.
      const ledger = this.db
        .prepare(
          `DELETE FROM tenant_credit_ledger
           WHERE run_id IN (
             SELECT run_id FROM (
               SELECT run_id AS run_id, SUM(amount_cents) AS net
               FROM tenant_credit_ledger
               WHERE run_id IS NOT NULL
                 AND run_id NOT IN (SELECT id FROM review_runs)
                 AND kind IN ('overage_debit', 'overage_refund', 'overage_partial_refund')
               GROUP BY run_id
               HAVING net = 0
             )
           )`,
        )
        .run().changes;
      return usage + runs + ledger;
    })();
    n += this.db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM mfa_challenges WHERE expires_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM auth_rate_limits WHERE reset_at < ?`).run(now).changes;
    n += this.db.prepare(`DELETE FROM abuse_signals WHERE created_at < ?`).run(abuseCutoff).changes;
    n += this.db
      .prepare(
        `DELETE FROM webhook_events
         WHERE provider LIKE '%-body'
           AND (
             (processed_at IS NOT NULL AND processed_at < ?)
             OR (processed_at IS NULL AND claimed_at < ?)
           )`,
      )
      .run(bodyHashCutoff, webhookCutoff).changes;
    n += this.db
      .prepare(
        `DELETE FROM webhook_events
         WHERE provider NOT LIKE '%-body'
           AND (
             (processed_at IS NOT NULL AND processed_at < ?)
             OR (processed_at IS NULL AND claimed_at < ?)
           )`,
      )
      .run(runCutoff, webhookCutoff).changes;
    return n;
  }

  /** Add email/password columns to an existing users table (email/password login). */
  private migrateUserAuthColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('email')) this.db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
    if (!names.has('email_verified_at')) this.db.exec(`ALTER TABLE users ADD COLUMN email_verified_at TEXT`);
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

    const names = new Set(cols.map((c) => c.name));
    const legacyName = `pr_reviews_legacy_${Date.now()}`;
    const column = (name: string, fallback: string): string =>
      names.has(name) ? `"${name.replace(/"/g, '""')}"` : fallback;
    // Preserve the old rows. The previous migration renamed the table, created
    // an empty replacement, and dropped the renamed table, silently erasing
    // every historical finding on the first restart after an upgrade.
    this.db.exec(`ALTER TABLE pr_reviews RENAME TO "${legacyName}"`);
    this.db.exec(`
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
        codex_thread_id TEXT,
        manual_review_json TEXT,
        PRIMARY KEY (installation_id, owner, repo, pr)
      );
    `);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pr_reviews
         (installation_id, owner, repo, pr, tenant_id, last_sha, findings_json,
          last_review_at, last_summary_comment_id, codex_thread_id, manual_review_json)
         SELECT 0,
                ${column('owner', "''")},
                ${column('repo', "''")},
                ${column('pr', '0')},
                'legacy',
                ${column('last_sha', "''")},
                ${column('findings_json', "'[]'")},
                ${column('last_review_at', "datetime('now')")},
                ${column('last_summary_comment_id', 'NULL')},
                ${column('codex_thread_id', 'NULL')},
                ${column('manual_review_json', 'NULL')}
         FROM "${legacyName}"`,
      )
      .run();
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

  getTenantByStripeCustomerId(customerId: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, slug, name, created_at FROM tenants WHERE stripe_customer_id = ?`)
      .get(customerId) as { id: string; slug: string; name: string; created_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at };
  }

  listStripeCustomers(): Array<{ tenantId: string; customerId: string }> {
    return this.db
      .prepare(
        `SELECT id AS tenantId, stripe_customer_id AS customerId
         FROM tenants WHERE stripe_customer_id IS NOT NULL`,
      )
      .all() as Array<{ tenantId: string; customerId: string }>;
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
           -- An installation is an ownership binding, not a mutable profile
           -- field. Keeping the existing tenant also closes the race where two
           -- callbacks both observe no row and the second callback rebinds it.
           tenant_id = github_installations.tenant_id,
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
        `SELECT tenant_id, last_sha, findings_json, last_review_at, last_summary_comment_id, codex_thread_id, manual_review_json
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
          manual_review_json: string | null;
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
      manualReview: row.manual_review_json ? JSON.parse(row.manual_review_json) : undefined,
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
         (installation_id, owner, repo, pr, tenant_id, last_sha, findings_json, last_review_at, last_summary_comment_id, codex_thread_id, manual_review_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           last_sha = excluded.last_sha,
           findings_json = excluded.findings_json,
           last_review_at = excluded.last_review_at,
           last_summary_comment_id = excluded.last_summary_comment_id,
           codex_thread_id = excluded.codex_thread_id,
           manual_review_json = excluded.manual_review_json`,
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
          state.manualReview ? JSON.stringify(state.manualReview) : null,
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
      // Verified OAuth email proves ownership — do not block unverified password
      // accounts (that enabled email DoS / permanent OAuth lockout). Clear any
      // unverified password credentials so an attacker who registered first
      // cannot keep password access after the victim links OAuth.
      this.db
        .prepare(
          `UPDATE users
           SET github_id = ?, login = ?, name = ?, avatar_url = ?, email = ?,
               email_verified_at = COALESCE(email_verified_at, ?),
               password_hash = CASE
                 WHEN password_hash IS NOT NULL AND email_verified_at IS NULL THEN NULL
                 ELSE password_hash
               END
           WHERE id = ?`,
        )
        .run(input.githubId, input.login, input.name ?? null, input.avatarUrl ?? null, email, new Date().toISOString(), existingEmail.id);
      this.revokeCredentialsAfterOAuthClaim(existingEmail.id);
      return this.getUserById(existingEmail.id)!;
    }

    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, avatar_url, email, email_verified_at, normalized_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.githubId, input.login, input.name ?? null, input.avatarUrl ?? null, email ?? null, email ? now : null, normEmail, now);
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
      // Same as GitHub: verified Google email may claim an unverified password row.
      // Drop unverified password credentials to prevent ATO after the link.
      this.db
        .prepare(
          `UPDATE users
           SET google_id = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url),
               email_verified_at = COALESCE(email_verified_at, ?),
               password_hash = CASE
                 WHEN password_hash IS NOT NULL AND email_verified_at IS NULL THEN NULL
                 ELSE password_hash
               END
           WHERE id = ?`,
        )
        .run(input.googleId, input.name ?? null, input.avatarUrl ?? null, new Date().toISOString(), existingEmail.id);
      this.revokeCredentialsAfterOAuthClaim(existingEmail.id);
      return this.getUserById(existingEmail.id)!;
    }

    const syntheticGithubId = syntheticUserId(`google:${input.googleId}`);
    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, avatar_url, email, email_verified_at, normalized_email, google_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        syntheticGithubId,
        email,
        input.name ?? null,
        input.avatarUrl ?? null,
        email,
        new Date().toISOString(),
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

  /** Mark a password email verified after a future email-verification flow. */
  setUserEmailVerified(userId: string, verifiedAt = new Date().toISOString()): boolean {
    return this.db
      .prepare(`UPDATE users SET email_verified_at = ? WHERE id = ? AND password_hash IS NOT NULL`)
      .run(verifiedAt, userId).changes > 0;
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
    // BEGIN IMMEDIATE so concurrent workers cannot both read under-budget and
    // both increment — deferred transactions race under WAL with multi-process.
    return this.db
      .transaction(() => {
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
      })
      .immediate();
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
        session: this.replaceUserSessions(row.user_id, sessionTtlMs),
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

  /**
   * After OAuth claims an existing email row, drop live sessions. If the claim
   * cleared an unverified password (see upsertUserFromGitHub/Google), also wipe
   * MFA so a planted password account cannot retain second-factor control.
   */
  revokeCredentialsAfterOAuthClaim(userId: string): void {
    this.deleteSessionsForUser(userId);
    if (this.getPasswordHash(userId)) return;
    this.db
      .prepare(
        `UPDATE user_security
         SET totp_enabled = 0,
             totp_secret_encrypted = NULL,
             recovery_code_hashes_json = '[]',
             last_totp_epoch = NULL,
             updated_at = ?
         WHERE user_id = ?`,
      )
      .run(new Date().toISOString(), userId);
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
    if (this.tenantHasMembers(tenantId)) return false;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM github_installations WHERE tenant_id = ?`)
      .get(tenantId) as { n: number };
    return row.n === 0;
  }

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

  /** Skipped runs for this PR with a given reason in the last `sinceMs` (nudge dedupe). */
  countRecentSkippedRuns(key: PrKey, skipReason: string, sinceMs: number): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?
           AND status = 'skipped' AND skip_reason = ? AND created_at >= ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr, skipReason, since) as { n: number };
    return row.n;
  }

  /** Failed review attempts for this PR in the last `sinceMs` (failure notice dedupe). */
  countRecentFailedRuns(key: PrKey, sinceMs = 30 * 60_000): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?
           AND status = 'failed' AND created_at >= ?`,
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
          skip_reason, error, duration_ms, findings_new, findings_fixed, findings_open, deep, free_tier,
          worker_id, heartbeat_at, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        this.workerId,
        now,
        input.status === 'running' ? null : now,
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
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      deep: Boolean(input.deep),
      freeTier: Boolean(input.freeTier),
      workerId: this.workerId,
      heartbeatAt: now,
      completedAt: input.status === 'running' ? undefined : now,
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
          skip_reason, error, duration_ms, findings_new, findings_fixed, findings_open, deep, free_tier,
          worker_id, heartbeat_at, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, 0, 0, 0, 0, ?, ?, ?, ?, NULL, ?)`,
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
        this.workerId,
        now,
        now,
      );
    return id;
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
    return this.db
      .transaction(() => {
        const reason = limitReason();
        if (reason) {
          this.recordReviewRun({
            ...input,
            status: 'skipped',
            skipReason: reason,
            durationMs: 0,
          });
          return { ok: false as const, reason };
        }
        // Compute debit BEFORE inserting the running row so `used` still
        // excludes this reservation (same semantics as the pre-txn check).
        const rawDebit =
          typeof input.computeOverageDebit === 'function'
            ? input.computeOverageDebit()
            : (input.overageDebitCents ?? 0);
        const debit = Math.max(0, Math.floor(Number(rawDebit) || 0));
        const runId = this.startReviewRun(input);
        if (debit > 0) {
          const ok = this.debitOverageCredits(
            input.tenantId,
            runId,
            debit,
            input.deep ? 'prepaid overage (deep=2 units)' : 'prepaid overage',
          );
          if (!ok) {
            this.completeReviewRun(runId, {
              status: 'skipped',
              skipReason: 'insufficient_credits',
              durationMs: 0,
            });
            return { ok: false as const, reason: 'insufficient_credits' };
          }
        }
        return { ok: true as const, runId };
      })
      .immediate();
  }

  /** Global count of free-tier reviews started across ALL accounts in the last
   *  `sinceMs` — the anchor for the free-tier daily spend circuit-breaker. Counts
   *  running + completed (a farm's in-flight reviews cost money too). */
  countGlobalFreeTierReviewsSince(sinceMs: number): number {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_runs
         WHERE free_tier = 1 AND (status IN ('running', 'completed', 'failed') OR (status = 'skipped' AND skip_reason LIKE 'interrupted by restart%'))
           AND action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%' AND created_at >= ?`,
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

  /**
   * Reopen the single run row reserved before a graceful restart. Reusing the
   * row keeps an interrupted attempt from consuming a second trial/hourly slot.
   * A completed row is reported separately so a late shutdown requeue cannot
   * run the same review twice.
   */
  resumeReviewRun(
    id: string,
    input: Pick<Parameters<AppDatabase['startReviewRun']>[0], 'tenantId' | 'installationId' | 'owner' | 'repo' | 'pr' | 'action'>,
  ): 'resumed' | 'completed' | 'unavailable' {
    const row = this.db
      .prepare(
        `SELECT status, skip_reason, tenant_id, installation_id, owner, repo, pr, action
         FROM review_runs WHERE id = ?`,
      )
      .get(id) as
      | {
          status: ReviewRunStatus;
          skip_reason: string | null;
          tenant_id: string;
          installation_id: number;
          owner: string;
          repo: string;
          pr: number;
          action: string;
        }
      | undefined;
    if (
      !row ||
      row.tenant_id !== input.tenantId ||
      row.installation_id !== input.installationId ||
      row.owner !== input.owner ||
      row.repo !== input.repo ||
      row.pr !== input.pr ||
      row.action !== input.action
    ) {
      return 'unavailable';
    }
    if (row.status === 'completed') return 'completed';
    if (row.status !== 'skipped' || !row.skip_reason?.startsWith('interrupted by restart')) {
      return 'unavailable';
    }
    const updated = this.db
      .prepare(
        `UPDATE review_runs
         SET status = 'running', skip_reason = NULL, error = NULL, duration_ms = 0,
             worker_id = ?, heartbeat_at = ?, completed_at = NULL
         WHERE id = ? AND status = 'skipped' AND skip_reason LIKE 'interrupted by restart%'`,
      )
      .run(this.workerId, new Date().toISOString(), id);
    return updated.changes > 0 ? 'resumed' : 'unavailable';
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
  ): void {
    const usageTotals = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM review_run_usage WHERE run_id = ?`,
      )
      .get(id) as { input_tokens: number; output_tokens: number; cost_usd: number };
    const completedAt = new Date().toISOString();
    const completed = this.db
      .prepare(
        `UPDATE review_runs
         SET status = ?, skip_reason = ?, error = ?, duration_ms = ?,
             findings_new = ?, findings_fixed = ?, findings_open = ?,
             input_tokens = ?, output_tokens = ?, cost_usd = ?,
             new_findings_json = ?,
             deep = COALESCE(?, deep), completed_at = ?, worker_id = NULL
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        patch.status,
        patch.skipReason ?? null,
        patch.error ?? null,
        patch.durationMs,
        patch.findingsNew ?? 0,
        patch.findingsFixed ?? 0,
        patch.findingsOpen ?? 0,
        patch.inputTokens ?? usageTotals.input_tokens,
        patch.outputTokens ?? usageTotals.output_tokens,
        patch.costUsd ?? usageTotals.cost_usd,
        patch.newFindings ? JSON.stringify(patch.newFindings) : null,
        patch.deep === undefined ? null : patch.deep ? 1 : 0,
        completedAt,
        id,
      );
    if (completed.changes > 0) {
      const danglingOutcome: ReviewRunAttemptOutcome = patch.status === 'skipped' ? 'cancelled' : 'failed';
      this.db
        .prepare(
          `UPDATE review_run_attempts
           SET outcome = ?, error = COALESCE(error, ?), completed_at = ?,
               duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
           WHERE run_id = ? AND outcome = 'running'`,
        )
        .run(danglingOutcome, patch.error ?? patch.skipReason ?? 'review ended before attempt completion', completedAt, completedAt, id);
    }
  }

  startReviewRunAttempt(input: Omit<ReviewRunAttempt, 'outcome' | 'durationMs' | 'completedAt'>): void {
    const run = this.db
      .prepare(`SELECT tenant_id FROM review_runs WHERE id = ?`)
      .get(input.runId) as { tenant_id: string } | undefined;
    if (!run || run.tenant_id !== input.tenantId) {
      throw new Error(`review attempt parent mismatch for run ${input.runId}`);
    }
    if (input.parentAttemptId) {
      const parent = this.db
        .prepare(`SELECT run_id FROM review_run_attempts WHERE id = ?`)
        .get(input.parentAttemptId) as { run_id: string } | undefined;
      if (!parent || parent.run_id !== input.runId) {
        throw new Error(`review attempt lineage mismatch for ${input.id}`);
      }
    }
    this.db
      .prepare(
        `INSERT INTO review_run_attempts
         (id, run_id, tenant_id, parent_attempt_id, provider, model, tier, pass_name,
          transport, retry_index, key_index, outcome, error, duration_ms, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, 0, ?, NULL)`,
      )
      .run(
        input.id,
        input.runId,
        input.tenantId,
        input.parentAttemptId ?? null,
        input.provider,
        input.model,
        input.tier,
        input.passName ?? null,
        input.transport,
        input.retryIndex,
        input.keyIndex,
        input.startedAt,
      );
  }

  completeReviewRunAttempt(input: {
    id: string;
    outcome: Exclude<ReviewRunAttemptOutcome, 'running'>;
    durationMs: number;
    completedAt: string;
    error?: string;
  }): boolean {
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
      throw new Error('invalid review attempt duration');
    }
    return this.db
      .prepare(
        `UPDATE review_run_attempts
         SET outcome = ?, error = ?, duration_ms = ?, completed_at = ?
         WHERE id = ? AND outcome = 'running'`,
      )
      .run(input.outcome, input.error ?? null, Math.floor(input.durationMs), input.completedAt, input.id).changes > 0;
  }

  listReviewRunAttempts(runId: string): ReviewRunAttempt[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_run_attempts WHERE run_id = ? ORDER BY started_at, id`)
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      tenantId: String(row.tenant_id),
      parentAttemptId: row.parent_attempt_id ? String(row.parent_attempt_id) : undefined,
      provider: String(row.provider),
      model: String(row.model),
      tier: String(row.tier),
      passName: row.pass_name ? String(row.pass_name) : undefined,
      transport: row.transport as ReviewRunAttempt['transport'],
      retryIndex: Number(row.retry_index),
      keyIndex: Number(row.key_index),
      outcome: row.outcome as ReviewRunAttemptOutcome,
      error: row.error ? String(row.error) : undefined,
      durationMs: Number(row.duration_ms),
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
    }));
  }

  /** Persist one provider usage event as soon as the provider reports it. */
  recordReviewRunUsage(
    input: Omit<ReviewRunUsage, 'id' | 'createdAt'> & { createdAt?: string },
  ): ReviewRunUsage {
    const run = this.db
      .prepare(`SELECT tenant_id FROM review_runs WHERE id = ?`)
      .get(input.runId) as { tenant_id: string } | undefined;
    if (!run) throw new Error(`cannot record usage for unknown review run ${input.runId}`);
    if (run.tenant_id !== input.tenantId) {
      throw new Error(`review usage tenant mismatch for run ${input.runId}`);
    }
    for (const [name, value] of Object.entries({
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      inputRatePerM: input.inputRatePerM,
      outputRatePerM: input.outputRatePerM,
      costUsd: input.costUsd,
    })) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`invalid review usage ${name}`);
    }
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO review_run_usage
         (id, run_id, tenant_id, provider, model, tier, pass_name,
          input_tokens, output_tokens, input_rate_per_m, output_rate_per_m,
          cost_usd, token_source, attempt_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.tenantId,
        input.provider,
        input.model,
        input.tier,
        input.passName ?? null,
        input.inputTokens,
        input.outputTokens,
        input.inputRatePerM,
        input.outputRatePerM,
        input.costUsd,
        input.tokenSource,
        input.attemptId ?? null,
        createdAt,
      );
    return { ...input, id, createdAt };
  }

  listReviewRunUsage(runId: string): ReviewRunUsage[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_run_usage WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
      .all(runId) as Array<{
      id: string;
      run_id: string;
      tenant_id: string;
      provider: string;
      model: string;
      tier: string;
      pass_name: string | null;
      input_tokens: number;
      output_tokens: number;
      input_rate_per_m: number;
      output_rate_per_m: number;
      cost_usd: number;
      token_source: string;
      attempt_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      tenantId: row.tenant_id,
      provider: row.provider,
      model: row.model,
      tier: row.tier,
      passName: row.pass_name ?? undefined,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      inputRatePerM: row.input_rate_per_m,
      outputRatePerM: row.output_rate_per_m,
      costUsd: row.cost_usd,
      tokenSource: row.token_source as ReviewRunUsage['tokenSource'],
      attemptId: row.attempt_id ?? undefined,
      createdAt: row.created_at,
    }));
  }

  /** Record gross Stripe revenue once; event_id makes webhook retries harmless. */
  recordStripeRevenueEvent(
    input: Omit<StripeRevenueEvent, 'createdAt'> & { createdAt?: string },
  ): boolean {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO stripe_revenue_events
         (event_id, event_type, invoice_id, tenant_id, customer_id, subscription_id,
          amount_cents, currency, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.eventType,
        input.invoiceId ?? null,
        input.tenantId ?? null,
        input.customerId ?? null,
        input.subscriptionId ?? null,
        input.amountCents,
        input.currency.trim().toLowerCase(),
        input.occurredAt,
        createdAt,
      );
    return result.changes > 0;
  }

  assignUnlinkedStripeRevenue(customerId: string, tenantId: string): number {
    if (!customerId.trim() || !tenantId.trim()) return 0;
    return this.db
      .prepare(
        `UPDATE stripe_revenue_events
         SET tenant_id = ?
         WHERE customer_id = ? AND tenant_id IS NULL`,
      )
      .run(tenantId, customerId)
      .changes;
  }

  sumStripeRefundsForCharge(chargeId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(-amount_cents), 0) AS amount_cents
         FROM stripe_revenue_events
         WHERE event_type = 'charge.refunded' AND invoice_id = ?`,
      )
      .get(chargeId) as { amount_cents: number };
    return Math.max(0, row.amount_cents);
  }

  enqueueStripeMeterEvent(input: {
    runId: string;
    tenantId: string;
    customerId: string;
    eventName: string;
    plan: string;
    units: number;
  }): StripeMeterEvent {
    const eventName = input.eventName.trim();
    if (!eventName) throw new Error('Stripe meter event name cannot be blank');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stripe_meter_events
         (run_id, tenant_id, customer_id, event_name, plan, units, status, attempts,
          last_error, next_attempt_at, reported_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.runId,
        input.tenantId,
        input.customerId,
        eventName,
        input.plan,
        Math.max(0, Math.floor(input.units)),
        now,
        now,
      );
    return this.getStripeMeterEvent(input.runId)!;
  }

  getStripeMeterEvent(runId: string): StripeMeterEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM stripe_meter_events WHERE run_id = ?`)
      .get(runId) as
      | {
          run_id: string;
          tenant_id: string;
          customer_id: string;
          event_name: string;
          plan: string;
          units: number;
          status: 'pending' | 'reported';
          attempts: number;
          last_error: string | null;
          next_attempt_at: string | null;
          reported_at: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          runId: row.run_id,
          tenantId: row.tenant_id,
          customerId: row.customer_id,
          eventName: row.event_name,
          plan: row.plan,
          units: row.units,
          status: row.status,
          attempts: row.attempts,
          lastError: row.last_error ?? undefined,
          nextAttemptAt: row.next_attempt_at ?? undefined,
          reportedAt: row.reported_at ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  listPendingStripeMeterEvents(limit = 50): StripeMeterEvent[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT run_id FROM stripe_meter_events
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(now, Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{ run_id: string }>;
    return rows.map((row) => this.getStripeMeterEvent(row.run_id)!).filter(Boolean);
  }

  markStripeMeterAttempt(runId: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE stripe_meter_events
         SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
         WHERE run_id = ? AND status = 'pending'`,
      )
      .run(error.slice(0, 1000), nextAttemptAt, new Date().toISOString(), runId);
  }

  setStripeMeterEventName(runId: string, eventName: string): void {
    const normalized = eventName.trim();
    if (!normalized) throw new Error('Stripe meter event name cannot be blank');
    this.db
      .prepare(
        `UPDATE stripe_meter_events
         SET event_name = ?, updated_at = ?
         WHERE run_id = ? AND status = 'pending'`,
      )
      .run(normalized, new Date().toISOString(), runId);
  }

  markStripeMeterReported(runId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE stripe_meter_events
         SET status = 'reported', reported_at = ?, last_error = NULL, next_attempt_at = NULL, updated_at = ?
         WHERE run_id = ? AND status = 'pending'`,
      )
      .run(now, now, runId);
  }

  listPlatformCosts(): PlatformCost[] {
    const rows = this.db
      .prepare(`SELECT category, amount_cents, note, updated_at FROM platform_costs ORDER BY category ASC`)
      .all() as Array<{ category: string; amount_cents: number; note: string | null; updated_at: string }>;
    return rows.map((row) => ({
      category: row.category,
      amountCents: row.amount_cents,
      note: row.note ?? undefined,
      updatedAt: row.updated_at,
    }));
  }

  upsertPlatformCost(input: { category: string; amountCents: number; note?: string }): PlatformCost {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO platform_costs (category, amount_cents, note, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(category) DO UPDATE SET amount_cents = excluded.amount_cents,
           note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(input.category, input.amountCents, input.note ?? null, updatedAt);
    return { ...input, updatedAt };
  }

  deletePlatformCost(category: string): boolean {
    return this.db.prepare(`DELETE FROM platform_costs WHERE category = ?`).run(category).changes > 0;
  }

  /**
   * Operator-only cost and margin source. Per-run usage is preferred; old rows
   * without ledger entries fall back to review_runs and are marked legacy.
   */
  getSuperadminCostAnalytics(
    sinceIso: string,
    untilIso: string,
    planPricesCents: Record<string, number> = {},
    recentLimit = 100,
  ): SuperadminCostAnalytics {
    const runCostCte = `
      WITH run_costs AS (
        SELECT run_id,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cost_usd) AS cost_usd
        FROM review_run_usage
        WHERE created_at >= ? AND created_at < ?
        GROUP BY run_id
      )`;
    const rangeArgs = [sinceIso, untilIso];

    const overviewRow = this.db
      .prepare(
        `${runCostCte}
         SELECT
           COUNT(*) AS runs,
           SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
           SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
           SUM(CASE WHEN r.status = 'skipped' THEN 1 ELSE 0 END) AS skipped_runs,
           SUM(CASE WHEN rc.run_id IS NULL THEN r.input_tokens ELSE rc.input_tokens END) AS input_tokens,
           SUM(CASE WHEN rc.run_id IS NULL THEN r.output_tokens ELSE rc.output_tokens END) AS output_tokens,
           SUM(CASE WHEN rc.run_id IS NULL THEN r.cost_usd ELSE rc.cost_usd END) AS cost_usd,
           SUM(CASE WHEN rc.run_id IS NULL AND r.cost_usd > 0 THEN r.cost_usd ELSE 0 END) AS legacy_cost_usd,
           COUNT(CASE WHEN rc.run_id IS NOT NULL THEN 1 END) AS instrumented_runs,
           COUNT(CASE WHEN r.cost_usd > 0 OR rc.run_id IS NOT NULL THEN 1 END) AS runs_with_cost
         FROM review_runs r
         LEFT JOIN run_costs rc ON rc.run_id = r.id
         WHERE r.created_at >= ? AND r.created_at < ?`,
      )
      .get(...rangeArgs, ...rangeArgs) as {
      runs: number;
      completed_runs: number | null;
      failed_runs: number | null;
      skipped_runs: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: number | null;
      legacy_cost_usd: number | null;
      instrumented_runs: number;
      runs_with_cost: number;
    };

    const revenueCurrencyRows = this.db
      .prepare(
        `SELECT lower(currency) AS currency, COALESCE(SUM(amount_cents), 0) AS amount_cents
         FROM stripe_revenue_events
         WHERE occurred_at >= ? AND occurred_at < ?
         GROUP BY lower(currency)`,
      )
      .all(...rangeArgs) as Array<{ currency: string; amount_cents: number }>;
    const revenueRow = revenueCurrencyRows.find((row) => row.currency === 'usd');
    const nonUsdRevenue = revenueCurrencyRows
      .filter((row) => row.currency !== 'usd')
      .map((row) => ({ currency: row.currency, amountCents: row.amount_cents }));
    const platformCosts = this.listPlatformCosts();
    const monthlyFixedCostUsd = platformCosts.reduce((sum, row) => sum + row.amountCents, 0) / 100;
    const rangeDays = Math.max(1 / 24, (Date.parse(untilIso) - Date.parse(sinceIso)) / 86_400_000);
    const allocatedFixedCostUsd = monthlyFixedCostUsd * rangeDays / 30;

    const modelRows = this.db
      .prepare(
        `SELECT provider, model, tier, COUNT(*) AS calls, COUNT(DISTINCT run_id) AS runs,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cost_usd) AS cost_usd
         FROM review_run_usage
         WHERE created_at >= ? AND created_at < ?
         GROUP BY provider, model, tier
         ORDER BY cost_usd DESC, model ASC`,
      )
      .all(...rangeArgs) as Array<{
      provider: string;
      model: string;
      tier: string;
      calls: number;
      runs: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>;

    const tenantRows = this.db
      .prepare(
        `${runCostCte}
         SELECT
           t.id AS tenant_id, t.slug, t.name, t.plan, t.stripe_subscription_status,
           COUNT(r.id) AS runs,
           SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
           SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
           SUM(CASE WHEN rc.run_id IS NULL THEN r.input_tokens ELSE rc.input_tokens END) AS input_tokens,
           SUM(CASE WHEN rc.run_id IS NULL THEN r.output_tokens ELSE rc.output_tokens END) AS output_tokens,
           SUM(CASE WHEN rc.run_id IS NULL THEN r.cost_usd ELSE rc.cost_usd END) AS cost_usd,
           COALESCE(revenue.amount_cents, 0) AS actual_revenue_cents
         FROM tenants t
         LEFT JOIN review_runs r
           ON r.tenant_id = t.id AND r.created_at >= ? AND r.created_at < ?
         LEFT JOIN run_costs rc ON rc.run_id = r.id
         LEFT JOIN (
           SELECT tenant_id, SUM(amount_cents) AS amount_cents
           FROM stripe_revenue_events
           WHERE occurred_at >= ? AND occurred_at < ? AND lower(currency) = 'usd'
           GROUP BY tenant_id
         ) revenue ON revenue.tenant_id = t.id
         GROUP BY t.id, revenue.amount_cents
         HAVING runs > 0 OR actual_revenue_cents != 0
         ORDER BY cost_usd DESC, t.slug ASC`,
      )
      .all(...rangeArgs, ...rangeArgs, ...rangeArgs) as Array<{
      tenant_id: string;
      slug: string;
      name: string;
      plan: string;
      stripe_subscription_status: string | null;
      runs: number;
      completed_runs: number | null;
      failed_runs: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: number | null;
      actual_revenue_cents: number;
    }>;

    const modeledRevenue = (plan: string, status: string | null): number => {
      if (
        plan === 'free' ||
        status === null ||
        ['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired'].includes(status)
      ) {
        return 0;
      }
      return (planPricesCents[plan] ?? 0) / 100;
    };
    // MRR is a current all-tenant metric, not a sum of only tenants that happened
    // to run during the selected analytics window. Keeping this query independent
    // prevents a quiet paid customer from disappearing from modeled margin when
    // the operator selects a short range.
    const modeledMonthlyRevenueUsd = (
      this.db
        .prepare(`SELECT plan, stripe_subscription_status FROM tenants`)
        .all() as Array<{ plan: string; stripe_subscription_status: string | null }>
    ).reduce(
      (sum, row) => sum + modeledRevenue(row.plan, row.stripe_subscription_status),
      0,
    );
    const byTenant = tenantRows.map((row) => ({
      tenantId: row.tenant_id,
      slug: row.slug,
      name: row.name,
      plan: row.plan,
      subscriptionStatus: row.stripe_subscription_status ?? undefined,
      runs: row.runs,
      completedRuns: row.completed_runs ?? 0,
      failedRuns: row.failed_runs ?? 0,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      costUsd: row.cost_usd ?? 0,
      actualRevenueUsd: row.actual_revenue_cents / 100,
      modeledMonthlyRevenueUsd: modeledRevenue(row.plan, row.stripe_subscription_status),
    }));

    const dailyCostRows = this.db
      .prepare(
        `${runCostCte}
         SELECT substr(r.created_at, 1, 10) AS day,
                SUM(CASE WHEN rc.run_id IS NULL THEN r.cost_usd ELSE rc.cost_usd END) AS cost_usd,
                COUNT(*) AS runs
         FROM review_runs r
         LEFT JOIN run_costs rc ON rc.run_id = r.id
         WHERE r.created_at >= ? AND r.created_at < ?
         GROUP BY day ORDER BY day ASC`,
      )
      .all(...rangeArgs, ...rangeArgs) as Array<{ day: string; cost_usd: number | null; runs: number }>;
    const dailyRevenueRows = this.db
      .prepare(
        `SELECT substr(occurred_at, 1, 10) AS day, SUM(amount_cents) AS amount_cents
         FROM stripe_revenue_events
         WHERE occurred_at >= ? AND occurred_at < ? AND lower(currency) = 'usd'
         GROUP BY day`,
      )
      .all(...rangeArgs) as Array<{ day: string; amount_cents: number }>;
    const revenueByDay = new Map(dailyRevenueRows.map((row) => [row.day, row.amount_cents / 100]));
    const daily = dailyCostRows.map((row) => ({
      day: row.day,
      costUsd: row.cost_usd ?? 0,
      actualRevenueUsd: revenueByDay.get(row.day) ?? 0,
      runs: row.runs,
    }));
    for (const row of dailyRevenueRows) {
      if (!daily.some((day) => day.day === row.day)) {
        daily.push({ day: row.day, costUsd: 0, actualRevenueUsd: row.amount_cents / 100, runs: 0 });
      }
    }
    daily.sort((a, b) => a.day.localeCompare(b.day));

    const recentRows = this.db
      .prepare(
        `${runCostCte}
         SELECT r.*, rc.input_tokens AS usage_input_tokens, rc.output_tokens AS usage_output_tokens,
                rc.cost_usd AS usage_cost_usd
         FROM review_runs r
         LEFT JOIN run_costs rc ON rc.run_id = r.id
         WHERE r.created_at >= ? AND r.created_at < ?
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(...rangeArgs, ...rangeArgs, recentLimit) as Array<{
      id: string;
      tenant_id: string;
      installation_id: number;
      owner: string;
      repo: string;
      pr: number;
      head_sha: string;
      action: string;
      status: ReviewRunStatus;
      skip_reason: string | null;
      error: string | null;
      duration_ms: number;
      findings_new: number;
      findings_fixed: number;
      findings_open: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      deep: number;
      free_tier: number;
      new_findings_json: string | null;
      worker_id: string | null;
      heartbeat_at: string | null;
      completed_at: string | null;
      created_at: string;
      usage_cost_usd: number | null;
    }>;
    const usageByRun = new Map<string, ReviewRunUsage[]>();
    for (const row of recentRows) usageByRun.set(row.id, this.listReviewRunUsage(row.id));
    const recentRuns = recentRows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      installationId: row.installation_id,
      owner: row.owner,
      repo: row.repo,
      pr: row.pr,
      headSha: row.head_sha,
      action: row.action,
      status: row.status,
      skipReason: row.skip_reason ?? undefined,
      error: row.error ?? undefined,
      durationMs: row.duration_ms,
      findingsNew: row.findings_new,
      findingsFixed: row.findings_fixed,
      findingsOpen: row.findings_open,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
      deep: row.deep === 1,
      freeTier: row.free_tier === 1,
      newFindings: row.new_findings_json ? parseNewFindings(row.new_findings_json) : undefined,
      workerId: row.worker_id ?? undefined,
      heartbeatAt: row.heartbeat_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      createdAt: row.created_at,
      usage: usageByRun.get(row.id) ?? [],
      actualCostUsd: row.usage_cost_usd ?? row.cost_usd,
      legacyCost: row.usage_cost_usd === null,
    }));

    return {
      since: sinceIso,
      until: untilIso,
      overview: {
        runs: overviewRow.runs,
        completedRuns: overviewRow.completed_runs ?? 0,
        failedRuns: overviewRow.failed_runs ?? 0,
        skippedRuns: overviewRow.skipped_runs ?? 0,
        inputTokens: overviewRow.input_tokens ?? 0,
        outputTokens: overviewRow.output_tokens ?? 0,
        costUsd: overviewRow.cost_usd ?? 0,
        actualRevenueUsd: (revenueRow?.amount_cents ?? 0) / 100,
        modeledMonthlyRevenueUsd,
        monthlyFixedCostUsd,
        allocatedFixedCostUsd,
        legacyCostUsd: overviewRow.legacy_cost_usd ?? 0,
        instrumentedRuns: overviewRow.instrumented_runs,
        runsWithCost: overviewRow.runs_with_cost,
        nonUsdRevenue,
      },
      byModel: modelRows.map((row) => ({
        provider: row.provider,
        model: row.model,
        tier: row.tier,
        calls: row.calls,
        runs: row.runs,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costUsd: row.cost_usd,
      })),
      byTenant,
      daily,
      platformCosts,
      recentRuns,
    };
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
        `WITH account_runs AS (
           SELECT id, cost_usd
           FROM review_runs
           WHERE lower(owner) = lower(?) AND created_at >= ?
         ),
         run_costs AS (
           SELECT u.run_id, SUM(u.cost_usd) AS cost
           FROM review_run_usage u
           INNER JOIN account_runs r ON r.id = u.run_id
           GROUP BY u.run_id
         )
         SELECT COALESCE(SUM(CASE WHEN rc.run_id IS NULL THEN r.cost_usd ELSE rc.cost END), 0) AS cost,
                COUNT(*) AS n
         FROM account_runs r
         LEFT JOIN run_costs rc ON rc.run_id = r.id
         WHERE r.cost_usd > 0 OR rc.run_id IS NOT NULL`,
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

  /** Disable a repository when GitHub removes it from the installation. */
  disableRepoByGitHubId(installationId: number, githubRepoId: number): boolean {
    const result = this.db
      .prepare(`UPDATE repos SET enabled = 0, updated_at = ? WHERE installation_id = ? AND github_repo_id = ?`)
      .run(new Date().toISOString(), installationId, githubRepoId);
    return result.changes > 0;
  }

  /** Disable all repository automations when an installation is deleted. */
  disableReposForInstallation(installationId: number): number {
    return this.db
      .prepare(`UPDATE repos SET enabled = 0, updated_at = ? WHERE installation_id = ? AND enabled = 1`)
      .run(new Date().toISOString(), installationId).changes;
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
   * settings-section toggles. `opened`/`reopened`/`ready_for_review` are gated
   * by reviewOnOpen; `synchronize` (a new push to an open PR) by reviewOnPush.
   * An unknown repo defaults to true for both (same "on before the dashboard is
   * visited" reasoning as isRepoEnabled) so a fresh install isn't silently inert.
   */
  isRepoActionEnabled(installationId: number, fullName: string, action: string): boolean {
    const repo = this.getRepoByFullName(installationId, fullName);
    if (!repo) return true;
    if (action === 'synchronize') return repo.reviewOnPush;
    return repo.reviewOnOpen; // opened, reopened, ready_for_review
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
    googleId: row.google_id ?? undefined,
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
const DOWNGRADED_SUB_STATUSES = new Set(['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired']);

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
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  deep: number;
  free_tier: number;
  new_findings_json: string | null;
  worker_id: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
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
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    costUsd: row.cost_usd ?? 0,
    deep: row.deep === 1,
    freeTier: row.free_tier === 1,
    newFindings: row.new_findings_json
      ? parseNewFindings(row.new_findings_json)
      : undefined,
    workerId: row.worker_id ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
  };
}

function parseNewFindings(raw: string): Array<{ severity: string; file: string; line?: number }> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter((item): item is { severity: string; file: string; line?: number } =>
        Boolean(item)
        && typeof item === 'object'
        && typeof (item as { severity?: unknown }).severity === 'string'
        && typeof (item as { file?: unknown }).file === 'string'
        && ((item as { line?: unknown }).line === undefined || Number.isFinite((item as { line?: unknown }).line)),
      );
  } catch {
    return undefined;
  }
}

let sharedDb: AppDatabase | null = null;

export function createAppDatabase(): AppDatabase {
  if (!sharedDb) {
    const configured = process.env.STORE_PATH;
    if (
      (process.env.NODE_ENV === 'production' || process.env.ORVEX_REQUIRE_DURABLE_STORAGE === '1') &&
      (!configured || !path.isAbsolute(configured) || configured.includes(`${path.sep}.data${path.sep}`))
    ) {
      throw new Error('STORE_PATH must be an absolute path outside the checkout in production');
    }
    sharedDb = new AppDatabase(configured ?? defaultDbPath());
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
