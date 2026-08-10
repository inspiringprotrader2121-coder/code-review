/**
 * The original schema installed by migration 1. This text is intentionally
 * immutable: upgraded databases use later migration steps, while fresh
 * databases receive this complete baseline before those idempotent repairs.
 */
export const BASELINE_SCHEMA_V2 = `
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
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  input_rate_per_m REAL NOT NULL DEFAULT 0 CHECK (input_rate_per_m >= 0),
  cached_input_rate_per_m REAL NOT NULL DEFAULT 0 CHECK (cached_input_rate_per_m >= 0),
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_revenue_invoice_paid
  ON stripe_revenue_events(invoice_id, event_type)
  WHERE invoice_id IS NOT NULL AND event_type = 'invoice.paid';
CREATE INDEX IF NOT EXISTS idx_stripe_revenue_tenant_time ON stripe_revenue_events(tenant_id, occurred_at);

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
CREATE INDEX IF NOT EXISTS idx_stripe_meter_pending ON stripe_meter_events(status, next_attempt_at);

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
CREATE TABLE IF NOT EXISTS abuse_signals (
  id TEXT PRIMARY KEY,
  ip TEXT,
  account_login TEXT,
  tenant_slug TEXT,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_abuse_ip_time ON abuse_signals(ip, created_at);
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
