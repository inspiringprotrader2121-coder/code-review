import type { SqliteConnection } from '../connection.js';
import {
  REVIEW_ATTEMPT_DISPATCH_ARTIFACT,
  REVIEW_ATTEMPT_ROLE_ARTIFACT,
  REVIEW_USAGE_CACHE_PRICING_ARTIFACT,
  REVIEW_USAGE_CACHE_WRITE_PRICING_ARTIFACT,
  STORE_MIGRATIONS,
} from './artifacts.js';
import { BASELINE_SCHEMA_V2 } from './baseline.js';

export interface ExecutableMigrationArtifact {
  readonly format: 'sqlite-sql-v1' | 'sqlite-program-v1';
  readonly sql?: string;
  readonly operations?: readonly string[];
}

export interface ExecutableMigrationStep {
  readonly version: number;
  readonly artifact: ExecutableMigrationArtifact;
  readonly apply: (db: SqliteConnection) => void;
}

type Column = { name: string };
const columns = (db: SqliteConnection, table: string): Set<string> =>
  new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Column[]).map((column) => column.name),
  );

function migrateLegacyPrReviews(db: SqliteConnection): void {
  const current = columns(db, 'pr_reviews');
  if (current.size === 0 || current.has('installation_id')) return;
  const legacyName = `pr_reviews_legacy_${Date.now()}`;
  const column = (name: string, fallback: string): string =>
    current.has(name) ? `"${name.replace(/"/g, '""')}"` : fallback;
  db.exec(`ALTER TABLE pr_reviews RENAME TO "${legacyName}"`);
  db.exec(`CREATE TABLE pr_reviews (
    installation_id INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'legacy', last_sha TEXT NOT NULL, findings_json TEXT NOT NULL,
    last_review_at TEXT NOT NULL, last_summary_comment_id INTEGER, codex_thread_id TEXT,
    manual_review_json TEXT, PRIMARY KEY (installation_id, owner, repo, pr)
  )`);
  db.prepare(
    `INSERT OR IGNORE INTO pr_reviews
    (installation_id, owner, repo, pr, tenant_id, last_sha, findings_json, last_review_at,
     last_summary_comment_id, codex_thread_id, manual_review_json)
    SELECT 0, ${column('owner', "''")}, ${column('repo', "''")}, ${column('pr', '0')}, 'legacy',
           ${column('last_sha', "''")}, ${column('findings_json', "'[]'")},
           ${column('last_review_at', "datetime('now')")}, ${column('last_summary_comment_id', 'NULL')},
           ${column('codex_thread_id', 'NULL')}, ${column('manual_review_json', 'NULL')}
    FROM "${legacyName}"`,
  ).run();
}

function migrateUserAuthColumns(db: SqliteConnection): void {
  const current = columns(db, 'users');
  const additions = [
    ['email', 'TEXT'],
    ['email_verified_at', 'TEXT'],
    ['google_id', 'TEXT'],
    ['password_hash', 'TEXT'],
    ['is_superadmin', 'INTEGER NOT NULL DEFAULT 0'],
    ['normalized_email', 'TEXT'],
  ] as const;
  for (const [name, declaration] of additions)
    if (!current.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${declaration}`);
  const duplicates = db
    .prepare(
      `UPDATE users SET email = NULL WHERE email IS NOT NULL AND rowid NOT IN (
    SELECT MIN(rowid) FROM users WHERE email IS NOT NULL GROUP BY lower(email)
  )`,
    )
    .run();
  if (duplicates.changes > 0)
    console.warn(
      `[store] nulled ${duplicates.changes} duplicate user email(s) so the unique index can be created`,
    );
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_users_normalized_email ON users(normalized_email) WHERE normalized_email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;`);
}

function migrateUserSecurityColumns(db: SqliteConnection): void {
  if (!columns(db, 'user_security').has('last_totp_epoch'))
    db.exec(`ALTER TABLE user_security ADD COLUMN last_totp_epoch INTEGER`);
}

function migrateTenantPlan(db: SqliteConnection): void {
  if (!columns(db, 'tenants').has('plan'))
    db.exec(`ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`);
}

function migrateTenantBillingColumns(db: SqliteConnection): void {
  const current = columns(db, 'tenants');
  for (const name of [
    'stripe_customer_id',
    'stripe_subscription_id',
    'stripe_subscription_status',
    'stripe_current_period_start',
    'stripe_current_period_end',
  ]) {
    if (!current.has(name)) db.exec(`ALTER TABLE tenants ADD COLUMN ${name} TEXT`);
  }
}

const PREPAID_CREDIT_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS tenant_credit_ledger (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL, run_id TEXT, stripe_session_id TEXT, note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON tenant_credit_ledger(tenant_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_stripe_session ON tenant_credit_ledger(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_run_debit ON tenant_credit_ledger(run_id) WHERE run_id IS NOT NULL AND amount_cents < 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_run_refund ON tenant_credit_ledger(run_id) WHERE run_id IS NOT NULL AND kind = 'overage_refund';`;

function migrateRepoAutomationToggles(db: SqliteConnection): void {
  const current = columns(db, 'repos');
  if (!current.has('review_on_open'))
    db.exec(`ALTER TABLE repos ADD COLUMN review_on_open INTEGER NOT NULL DEFAULT 1`);
  if (!current.has('review_on_push'))
    db.exec(`ALTER TABLE repos ADD COLUMN review_on_push INTEGER NOT NULL DEFAULT 1`);
}

function migrateReviewRunCostColumns(db: SqliteConnection): void {
  const current = columns(db, 'review_runs');
  const additions = [
    ['input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['cost_usd', 'REAL NOT NULL DEFAULT 0'],
    ['deep', 'INTEGER NOT NULL DEFAULT 0'],
    ['free_tier', 'INTEGER NOT NULL DEFAULT 0'],
    ['new_findings_json', 'TEXT'],
  ] as const;
  for (const [name, declaration] of additions)
    if (!current.has(name)) db.exec(`ALTER TABLE review_runs ADD COLUMN ${name} ${declaration}`);
}

const REVIEW_RUN_LIFECYCLE_SQL = `
UPDATE review_runs SET completed_at = created_at WHERE status <> 'running' AND completed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_id_tenant ON review_runs(id, tenant_id);
CREATE TRIGGER IF NOT EXISTS trg_review_runs_tenant_insert BEFORE INSERT ON review_runs
WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'review_runs tenant foreign key violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_runs_tenant_update BEFORE UPDATE OF tenant_id ON review_runs
WHEN NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'review_runs tenant foreign key violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_runs_check_insert BEFORE INSERT ON review_runs
WHEN NEW.status NOT IN ('running','completed','skipped','failed') OR NEW.duration_ms < 0
  OR NEW.findings_new < 0 OR NEW.findings_fixed < 0 OR NEW.findings_open < 0
  OR NEW.input_tokens < 0 OR NEW.output_tokens < 0 OR NEW.cost_usd < 0
  OR NEW.deep NOT IN (0,1) OR NEW.free_tier NOT IN (0,1)
BEGIN SELECT RAISE(ABORT, 'review_runs check constraint violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_runs_check_update BEFORE UPDATE ON review_runs
WHEN NEW.status NOT IN ('running','completed','skipped','failed') OR NEW.duration_ms < 0
  OR NEW.findings_new < 0 OR NEW.findings_fixed < 0 OR NEW.findings_open < 0
  OR NEW.input_tokens < 0 OR NEW.output_tokens < 0 OR NEW.cost_usd < 0
  OR NEW.deep NOT IN (0,1) OR NEW.free_tier NOT IN (0,1)
BEGIN SELECT RAISE(ABORT, 'review_runs check constraint violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_usage_parent_insert BEFORE INSERT ON review_run_usage
WHEN NOT EXISTS (SELECT 1 FROM review_runs WHERE id = NEW.run_id AND tenant_id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'review_run_usage foreign key violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_usage_check_insert BEFORE INSERT ON review_run_usage
WHEN NEW.input_tokens < 0 OR NEW.output_tokens < 0 OR NEW.input_rate_per_m < 0
  OR NEW.output_rate_per_m < 0 OR NEW.cost_usd < 0
BEGIN SELECT RAISE(ABORT, 'review_run_usage check constraint violation'); END;`;

function migrateReviewRunLifecycleColumns(db: SqliteConnection): void {
  const current = columns(db, 'review_runs');
  for (const name of ['worker_id', 'heartbeat_at', 'completed_at'])
    if (!current.has(name)) db.exec(`ALTER TABLE review_runs ADD COLUMN ${name} TEXT`);
  db.exec(REVIEW_RUN_LIFECYCLE_SQL);
}

function migratePrReviewColumns(db: SqliteConnection): void {
  const current = columns(db, 'pr_reviews');
  if (!current.has('codex_thread_id'))
    db.exec(`ALTER TABLE pr_reviews ADD COLUMN codex_thread_id TEXT`);
  if (!current.has('manual_review_json'))
    db.exec(`ALTER TABLE pr_reviews ADD COLUMN manual_review_json TEXT`);
}

function migrateRevenueIndexes(db: SqliteConnection): void {
  db.exec(`DROP INDEX IF EXISTS idx_stripe_revenue_invoice_type;
DROP INDEX IF EXISTS idx_stripe_revenue_invoice_paid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_revenue_invoice_paid
  ON stripe_revenue_events(invoice_id, event_type)
  WHERE invoice_id IS NOT NULL AND event_type = 'invoice.paid';`);
}

function migrateWebhookEventColumns(db: SqliteConnection): void {
  if (!columns(db, 'webhook_events').has('claim_token'))
    db.exec(`ALTER TABLE webhook_events ADD COLUMN claim_token TEXT`);
  db.exec(
    `UPDATE webhook_events SET claim_token = lower(hex(randomblob(16))) WHERE claim_token IS NULL OR claim_token = ''`,
  );
}

const REVIEW_ATTEMPT_LINEAGE_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_review_attempt_parent_same_run_insert BEFORE INSERT ON review_run_attempts
WHEN NEW.parent_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_run_attempts parent WHERE parent.id = NEW.parent_attempt_id
    AND parent.run_id = NEW.run_id AND parent.tenant_id = NEW.tenant_id
) BEGIN SELECT RAISE(ABORT, 'review attempt parent lineage mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_attempt_parent_same_run_update BEFORE UPDATE OF parent_attempt_id, run_id, tenant_id ON review_run_attempts
WHEN NEW.parent_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_run_attempts parent WHERE parent.id = NEW.parent_attempt_id
    AND parent.run_id = NEW.run_id AND parent.tenant_id = NEW.tenant_id
) BEGIN SELECT RAISE(ABORT, 'review attempt parent lineage mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_usage_attempt_same_run_insert BEFORE INSERT ON review_run_usage
WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_run_attempts attempt WHERE attempt.id = NEW.attempt_id
    AND attempt.run_id = NEW.run_id AND attempt.tenant_id = NEW.tenant_id
) BEGIN SELECT RAISE(ABORT, 'review usage attempt lineage mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_usage_attempt_same_run_update BEFORE UPDATE OF attempt_id, run_id, tenant_id ON review_run_usage
WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_run_attempts attempt WHERE attempt.id = NEW.attempt_id
    AND attempt.run_id = NEW.run_id AND attempt.tenant_id = NEW.tenant_id
) BEGIN SELECT RAISE(ABORT, 'review usage attempt lineage mismatch'); END;`;

function migrateReviewAttemptLineageIntegrity(db: SqliteConnection): void {
  const invalidParent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM review_run_attempts child LEFT JOIN review_run_attempts parent
    ON parent.id = child.parent_attempt_id AND parent.run_id = child.run_id AND parent.tenant_id = child.tenant_id
    WHERE child.parent_attempt_id IS NOT NULL AND parent.id IS NULL`,
    )
    .get() as { n: number };
  const invalidUsage = db
    .prepare(
      `SELECT COUNT(*) AS n FROM review_run_usage usage LEFT JOIN review_run_attempts attempt
    ON attempt.id = usage.attempt_id AND attempt.run_id = usage.run_id AND attempt.tenant_id = usage.tenant_id
    WHERE usage.attempt_id IS NOT NULL AND attempt.id IS NULL`,
    )
    .get() as { n: number };
  if (invalidParent.n > 0 || invalidUsage.n > 0)
    throw new Error(
      `review attempt lineage integrity failed: ${invalidParent.n} invalid parent(s), ${invalidUsage.n} invalid usage link(s)`,
    );
  db.exec(REVIEW_ATTEMPT_LINEAGE_SQL);
}

const REVIEW_USAGE_CACHE_PRICING_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_review_usage_cached_input_insert BEFORE INSERT ON review_run_usage
WHEN NEW.cached_input_tokens < 0 OR NEW.cached_input_tokens > NEW.input_tokens
  OR NEW.cached_input_rate_per_m < 0
BEGIN SELECT RAISE(ABORT, 'review usage cached-input constraint violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_usage_cached_input_update BEFORE UPDATE OF cached_input_tokens, input_tokens, cached_input_rate_per_m ON review_run_usage
WHEN NEW.cached_input_tokens < 0 OR NEW.cached_input_tokens > NEW.input_tokens
  OR NEW.cached_input_rate_per_m < 0
BEGIN SELECT RAISE(ABORT, 'review usage cached-input constraint violation'); END;`;

function migrateReviewUsageCachePricingColumns(db: SqliteConnection): void {
  const current = columns(db, 'review_run_usage');
  if (!current.has('cached_input_tokens'))
    db.exec(
      `ALTER TABLE review_run_usage ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  if (!current.has('cached_input_rate_per_m'))
    db.exec(
      `ALTER TABLE review_run_usage ADD COLUMN cached_input_rate_per_m REAL NOT NULL DEFAULT 0`,
    );
  db.exec(REVIEW_USAGE_CACHE_PRICING_SQL);
}

const REVIEW_USAGE_CACHE_WRITE_PRICING_SQL = `
DROP TRIGGER IF EXISTS trg_review_usage_cached_input_insert;
DROP TRIGGER IF EXISTS trg_review_usage_cached_input_update;
CREATE TRIGGER IF NOT EXISTS trg_review_usage_cache_tokens_insert BEFORE INSERT ON review_run_usage
WHEN NEW.cached_input_tokens < 0 OR NEW.cache_write_tokens < 0
  OR NEW.cached_input_tokens + NEW.cache_write_tokens > NEW.input_tokens
  OR NEW.cached_input_rate_per_m < 0 OR NEW.cache_write_rate_per_m < 0
BEGIN SELECT RAISE(ABORT, 'review usage cache-token constraint violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_usage_cache_tokens_update BEFORE UPDATE OF cached_input_tokens, cache_write_tokens, input_tokens, cached_input_rate_per_m, cache_write_rate_per_m ON review_run_usage
WHEN NEW.cached_input_tokens < 0 OR NEW.cache_write_tokens < 0
  OR NEW.cached_input_tokens + NEW.cache_write_tokens > NEW.input_tokens
  OR NEW.cached_input_rate_per_m < 0 OR NEW.cache_write_rate_per_m < 0
BEGIN SELECT RAISE(ABORT, 'review usage cache-token constraint violation'); END;`;

function migrateReviewUsageCacheWritePricingColumns(db: SqliteConnection): void {
  const current = columns(db, 'review_run_usage');
  if (!current.has('cache_write_tokens'))
    db.exec(
      `ALTER TABLE review_run_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  if (!current.has('cache_write_rate_per_m'))
    db.exec(
      `ALTER TABLE review_run_usage ADD COLUMN cache_write_rate_per_m REAL NOT NULL DEFAULT 0`,
    );
  db.exec(REVIEW_USAGE_CACHE_WRITE_PRICING_SQL);
}

function migrateReviewAttemptDispatchColumn(db: SqliteConnection): void {
  if (!columns(db, 'review_run_attempts').has('dispatched'))
    db.exec(
      `ALTER TABLE review_run_attempts ADD COLUMN dispatched INTEGER NOT NULL DEFAULT 1 CHECK (dispatched IN (0, 1))`,
    );
}

function migrateReviewAttemptRoleColumn(db: SqliteConnection): void {
  if (!columns(db, 'review_run_attempts').has('role'))
    db.exec(
      `ALTER TABLE review_run_attempts ADD COLUMN role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'retry', 'continuation'))`,
    );
}

function migrateCanonicalMigrationArtifacts(db: SqliteConnection): void {
  if (!columns(db, 'orvex_schema_migrations').has('artifact_timestamp'))
    db.exec(`ALTER TABLE orvex_schema_migrations ADD COLUMN artifact_timestamp TEXT`);
  const update = db.prepare(
    `UPDATE orvex_schema_migrations SET checksum = ?, artifact_timestamp = ? WHERE version = ? AND name = ?`,
  );
  for (const migration of STORE_MIGRATIONS.filter((migration) => migration.version < 15)) {
    update.run(migration.checksum, migration.timestamp, migration.version, migration.name);
  }
}

const REVIEW_PUBLICATION_FENCING_SQL = `
CREATE TABLE IF NOT EXISTS review_publications (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('publishing', 'published')), claim_token TEXT NOT NULL,
  claimed_by TEXT NOT NULL, claimed_at TEXT NOT NULL, result_json TEXT, published_at TEXT,
  PRIMARY KEY (tenant_id, run_id, artifact_key),
  FOREIGN KEY (run_id, tenant_id) REFERENCES review_runs(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_review_publications_run ON review_publications(run_id, tenant_id);`;

const REVIEW_PUBLICATION_RESOLUTION_AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS review_publication_resolutions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('retry', 'mark_published')), actor TEXT NOT NULL, reason TEXT NOT NULL,
  claim_token_digest TEXT NOT NULL, claimed_by TEXT NOT NULL, claimed_at TEXT NOT NULL,
  result_json TEXT, resolved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_publication_resolutions_time ON review_publication_resolutions(resolved_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_review_publication_resolutions_immutable_update BEFORE UPDATE ON review_publication_resolutions
BEGIN SELECT RAISE(ABORT, 'publication resolution audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_publication_resolutions_parent_insert BEFORE INSERT ON review_publication_resolutions
WHEN NOT EXISTS (SELECT 1 FROM review_runs WHERE id = NEW.run_id AND tenant_id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'publication resolution run ownership violation'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_publication_resolutions_immutable_delete BEFORE DELETE ON review_publication_resolutions
BEGIN SELECT RAISE(ABORT, 'publication resolution audit is immutable'); END;`;

const program = (operations: readonly string[]): ExecutableMigrationArtifact =>
  Object.freeze({ format: 'sqlite-program-v1', operations: Object.freeze(operations) });
const sql = (statement: string): ExecutableMigrationArtifact =>
  Object.freeze({ format: 'sqlite-sql-v1', sql: statement });

export const STORE_MIGRATION_STEPS: readonly ExecutableMigrationStep[] = Object.freeze(
  [
    {
      version: 1,
      artifact: sql(BASELINE_SCHEMA_V2),
      apply: (db: SqliteConnection) => db.exec(BASELINE_SCHEMA_V2),
    },
    {
      version: 2,
      artifact: program(['inspect pr_reviews', 'rename legacy table', 'copy preserved rows']),
      apply: migrateLegacyPrReviews,
    },
    {
      version: 3,
      artifact: program([
        'add user identity columns',
        'deduplicate email',
        'create identity indexes',
      ]),
      apply: migrateUserAuthColumns,
    },
    {
      version: 4,
      artifact: program(['add user_security.last_totp_epoch']),
      apply: migrateUserSecurityColumns,
    },
    { version: 5, artifact: program(['add tenants.plan default free']), apply: migrateTenantPlan },
    {
      version: 6,
      artifact: program(['add Stripe tenant billing columns']),
      apply: migrateTenantBillingColumns,
    },
    {
      version: 7,
      artifact: sql(PREPAID_CREDIT_LEDGER_SQL),
      apply: (db: SqliteConnection) => db.exec(PREPAID_CREDIT_LEDGER_SQL),
    },
    {
      version: 8,
      artifact: program(['add repositories review_on_open and review_on_push']),
      apply: migrateRepoAutomationToggles,
    },
    {
      version: 9,
      artifact: program(['add review run cost and depth columns']),
      apply: migrateReviewRunCostColumns,
    },
    {
      version: 10,
      artifact: program(['add review lifecycle columns', REVIEW_RUN_LIFECYCLE_SQL]),
      apply: migrateReviewRunLifecycleColumns,
    },
    {
      version: 11,
      artifact: program(['add pr_reviews Codex and manual review columns']),
      apply: migratePrReviewColumns,
    },
    {
      version: 12,
      artifact: program(['replace Stripe revenue uniqueness index']),
      apply: migrateRevenueIndexes,
    },
    {
      version: 13,
      artifact: program(['add and backfill webhook claim token']),
      apply: migrateWebhookEventColumns,
    },
    {
      version: 14,
      artifact: program(['verify same-run lineage', REVIEW_ATTEMPT_LINEAGE_SQL]),
      apply: migrateReviewAttemptLineageIntegrity,
    },
    {
      version: 15,
      artifact: program(['record canonical ledger checksum and timestamp']),
      apply: migrateCanonicalMigrationArtifacts,
    },
    {
      version: 16,
      artifact: sql(REVIEW_PUBLICATION_FENCING_SQL),
      apply: (db: SqliteConnection) => db.exec(REVIEW_PUBLICATION_FENCING_SQL),
    },
    {
      version: 17,
      artifact: sql(REVIEW_PUBLICATION_RESOLUTION_AUDIT_SQL),
      apply: (db: SqliteConnection) => db.exec(REVIEW_PUBLICATION_RESOLUTION_AUDIT_SQL),
    },
    {
      version: 18,
      artifact: REVIEW_USAGE_CACHE_PRICING_ARTIFACT,
      apply: migrateReviewUsageCachePricingColumns,
    },
    {
      version: 19,
      artifact: REVIEW_USAGE_CACHE_WRITE_PRICING_ARTIFACT,
      apply: migrateReviewUsageCacheWritePricingColumns,
    },
    {
      version: 20,
      artifact: REVIEW_ATTEMPT_DISPATCH_ARTIFACT,
      apply: migrateReviewAttemptDispatchColumn,
    },
    {
      version: 21,
      artifact: REVIEW_ATTEMPT_ROLE_ARTIFACT,
      apply: migrateReviewAttemptRoleColumn,
    },
  ].map((step) => Object.freeze(step)),
);

export function findMigrationStep(version: number): ExecutableMigrationStep {
  const step = STORE_MIGRATION_STEPS.find((candidate) => candidate.version === version);
  if (!step) throw new Error(`unknown schema migration version ${version}`);
  return step;
}
