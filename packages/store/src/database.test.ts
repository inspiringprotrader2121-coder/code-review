import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppDatabase } from './database.js';
import { STORE_MIGRATIONS } from './migrations.js';

function freshDb(): AppDatabase {
  return new AppDatabase(':memory:');
}

type MigrationRow = {
  version: number;
  name: string;
  checksum: string;
  artifact_timestamp: string | null;
  applied_at: string;
};

function migrationRows(database: AppDatabase): MigrationRow[] {
  const raw = (
    database as unknown as { db: { prepare: (sql: string) => { all: () => MigrationRow[] } } }
  ).db;
  return raw
    .prepare(
      `SELECT version, name, checksum, artifact_timestamp, applied_at FROM orvex_schema_migrations ORDER BY version`,
    )
    .all();
}

test('migration ledger records the full ordered schema history on first boot', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-migrations-'));
  try {
    const db = new AppDatabase(path.join(directory, 'store.db'));
    const rows = migrationRows(db);
    assert.deepEqual(
      rows.map(({ version, name }) => ({ version, name })),
      STORE_MIGRATIONS.map(({ version, name }) => ({ version, name })),
    );
    for (const [index, row] of rows.entries()) {
      const expected = STORE_MIGRATIONS[index]!;
      assert.equal(row.checksum, expected.checksum);
      assert.equal(row.artifact_timestamp, expected.timestamp);
      assert.ok(Number.isFinite(Date.parse(row.applied_at)));
    }
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } };
      }
    ).db;
    const lineageTriggers = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_review_%_same_run_%' ORDER BY name`,
      )
      .all();
    assert.equal(lineageTriggers.length, 4);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a pre-canonical v14 ledger fixture upgrades to immutable artifacts and passes SQLite checks', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-historical-fixture-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const fixture = new AppDatabase(dbPath);
    const tenant = fixture.createTenant('historical-fixture');
    const runId = fixture.startReviewRun({
      tenantId: tenant.id,
      installationId: 1,
      owner: 'historical-fixture',
      repo: 'api',
      pr: 1,
      headSha: 'historical-sha',
      action: 'manual',
    });
    fixture.completeReviewRun(runId, { status: 'completed', durationMs: 1 });
    const raw = (
      fixture as unknown as {
        db: {
          prepare: (sql: string) => {
            run: (...params: unknown[]) => unknown;
            all: () => unknown[];
          };
          pragma: (value: string, options?: { simple?: boolean }) => unknown;
        };
      }
    ).db;
    for (const migration of STORE_MIGRATIONS.filter((migration) => migration.version < 15)) {
      raw
        .prepare(
          `UPDATE orvex_schema_migrations SET checksum = ?, artifact_timestamp = NULL WHERE version = ?`,
        )
        .run(migration.legacyChecksums[0], migration.version);
    }
    raw.prepare(`DELETE FROM orvex_schema_migrations WHERE version >= 15`).run();
    fixture.close();

    const upgraded = new AppDatabase(dbPath);
    assert.equal(upgraded.listReviewRuns(tenant.id, 1)[0]?.id, runId);
    assert.deepEqual(
      migrationRows(upgraded).map(({ version, checksum, artifact_timestamp }) => ({
        version,
        checksum,
        artifact_timestamp,
      })),
      STORE_MIGRATIONS.map(({ version, checksum, timestamp }) => ({
        version,
        checksum,
        artifact_timestamp: timestamp,
      })),
    );
    const upgradedRaw = (
      upgraded as unknown as {
        db: {
          prepare: (sql: string) => { all: () => unknown[] };
          pragma: (value: string, options?: { simple?: boolean }) => unknown;
        };
      }
    ).db;
    assert.equal(upgradedRaw.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(upgradedRaw.prepare('PRAGMA foreign_key_check').all(), []);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration ledger is unchanged on repeat boot', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-migrations-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const first = new AppDatabase(dbPath);
    const before = migrationRows(first);
    first.close();

    const second = new AppDatabase(dbPath);
    assert.deepEqual(migrationRows(second), before);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lineage migration preserves legacy usage while clearing unprovable links', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-migrations-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const legacy = new AppDatabase(dbPath, 'legacy-worker');
    const tenant = legacy.createTenant('legacy-lineage');
    const runId = legacy.startReviewRun({
      tenantId: tenant.id,
      installationId: 1,
      owner: 'legacy-lineage',
      repo: 'api',
      pr: 1,
      headSha: 'sha',
      action: 'manual',
    });
    legacy.startReviewRunAttempt({
      id: 'legacy-child',
      runId,
      tenantId: tenant.id,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      tier: 'deepseek-flash',
      transport: 'chat',
      retryIndex: 0,
      keyIndex: 0,
      startedAt: new Date().toISOString(),
    });
    const otherRunId = legacy.startReviewRun({
      tenantId: tenant.id,
      installationId: 1,
      owner: 'legacy-lineage',
      repo: 'api',
      pr: 2,
      headSha: 'other-sha',
      action: 'manual',
    });
    legacy.startReviewRunAttempt({
      id: 'other-run-parent',
      runId: otherRunId,
      tenantId: tenant.id,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      tier: 'deepseek-flash',
      transport: 'chat',
      retryIndex: 0,
      keyIndex: 0,
      startedAt: new Date().toISOString(),
    });
    const usage = legacy.recordReviewRunUsage({
      runId,
      tenantId: tenant.id,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      tier: 'deepseek-flash',
      inputTokens: 10,
      outputTokens: 5,
      inputRatePerM: 1,
      outputRatePerM: 1,
      costUsd: 0.000015,
      tokenSource: 'provider',
    });
    assert.ok(usage);
    const raw = (
      legacy as unknown as {
        db: {
          exec: (sql: string) => void;
          prepare: (sql: string) => { run: (...params: unknown[]) => unknown };
        };
      }
    ).db;
    raw.exec(`
DROP TRIGGER trg_review_attempt_parent_same_run_insert;
DROP TRIGGER trg_review_attempt_parent_same_run_update;
DROP TRIGGER trg_review_usage_attempt_same_run_insert;
DROP TRIGGER trg_review_usage_attempt_same_run_update;
`);
    raw
      .prepare(`UPDATE review_run_usage SET attempt_id = 'missing-legacy-attempt' WHERE id = ?`)
      .run(usage.id);
    raw
      .prepare(
        `UPDATE review_run_attempts SET parent_attempt_id = 'other-run-parent' WHERE id = 'legacy-child'`,
      )
      .run();
    raw.prepare(`DELETE FROM orvex_schema_migrations WHERE version >= 14`).run();
    legacy.close();

    const upgraded = new AppDatabase(dbPath, 'upgraded-worker');
    const retainedUsage = upgraded.listReviewRunUsage(runId);
    assert.equal(retainedUsage.length, 1);
    assert.equal(retainedUsage[0]?.costUsd, 0.000015);
    assert.equal(retainedUsage[0]?.attemptId, undefined);
    assert.equal(upgraded.listReviewRunAttempts(runId)[0]?.parentAttemptId, undefined);
    assert.equal(migrationRows(upgraded).length, STORE_MIGRATIONS.length);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a populated pre-ledger database is upgraded without changing its data', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-migrations-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const beforeLedger = new AppDatabase(dbPath);
    const user = beforeLedger.upsertUserFromGitHub({ githubId: 77, login: 'pre-ledger-user' });
    const raw = (
      beforeLedger as unknown as {
        db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };
      }
    ).db;
    raw.prepare(`DROP TABLE orvex_schema_migrations`).run();
    beforeLedger.close();

    const upgraded = new AppDatabase(dbPath);
    assert.equal(upgraded.getUserByGitHubId(77)?.id, user.id);
    assert.equal(migrationRows(upgraded).length, STORE_MIGRATIONS.length);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration ledger rejects historical checksum or version mismatches', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-migrations-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const checksumDb = new AppDatabase(dbPath);
    const raw = (
      checksumDb as unknown as {
        db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };
      }
    ).db;
    raw.prepare(`UPDATE orvex_schema_migrations SET checksum = 'changed' WHERE version = 1`).run();
    checksumDb.close();
    assert.throws(() => new AppDatabase(dbPath), /migration ledger checksum mismatch/);

    const versionDb = new AppDatabase(path.join(directory, 'version.db'));
    const versionRaw = (
      versionDb as unknown as {
        db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };
      }
    ).db;
    versionRaw.prepare(`UPDATE orvex_schema_migrations SET version = 99 WHERE version = 14`).run();
    versionDb.close();
    assert.throws(
      () => new AppDatabase(path.join(directory, 'version.db')),
      /migration ledger version mismatch/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('users: upsert by github id updates profile, keeps id', () => {
  const db = freshDb();
  const a = db.upsertUserFromGitHub({ githubId: 42, login: 'octocat' });
  const b = db.upsertUserFromGitHub({ githubId: 42, login: 'octocat-renamed', name: 'Octo' });
  assert.equal(a.id, b.id);
  assert.equal(b.login, 'octocat-renamed');
  assert.equal(b.name, 'Octo');
});

test('stale-run cleanup leaves fresh running work alone during a rolling restart', () => {
  const db = freshDb();
  const tenant = db.createTenant('live-worker');
  db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'live-worker',
    repo: 'api',
    pr: 1,
    headSha: 'live',
    action: 'synchronize',
  });
  assert.equal(db.failStaleRunningRuns({ staleAfterMs: 60 * 60_000 }), 0);
});

test('startup cleanup interrupts only rows whose heartbeat is stale', () => {
  const db = freshDb();
  const tenant = db.createTenant('sole-worker');
  const runId = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'sole-worker',
    repo: 'api',
    pr: 1,
    headSha: 'fresh',
    action: 'synchronize',
  });
  db.startReviewRunAttempt({
    id: 'stale-attempt',
    runId,
    tenantId: tenant.id,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    tier: 'deepseek-flash',
    transport: 'chat',
    retryIndex: 0,
    keyIndex: 0,
    startedAt: new Date().toISOString(),
  });
  assert.equal(db.failStaleRunningRuns({ staleAfterMs: 60_000 }), 0, 'fresh peer work survives');
  assert.equal(db.failStaleRunningRuns({ staleAfterMs: 60_000, nowMs: Date.now() + 61_000 }), 1);
  assert.equal(db.listReviewRunAttempts(runId)[0]?.outcome, 'cancelled');
  assert.equal(
    db.resumeReviewRun(runId, {
      tenantId: tenant.id,
      installationId: 1,
      owner: 'sole-worker',
      repo: 'api',
      pr: 1,
      action: 'synchronize',
    }),
    'resumed',
  );
});

test('review runs enforce tenant ownership and non-negative lifecycle fields', () => {
  const db = freshDb();
  assert.throws(
    () =>
      db.startReviewRun({
        tenantId: 'missing-tenant',
        installationId: 1,
        owner: 'missing',
        repo: 'api',
        pr: 1,
        headSha: 'sha',
        action: 'manual',
      }),
    /tenant foreign key violation|FOREIGN KEY constraint failed/,
  );

  const tenant = db.createTenant('integrity');
  assert.throws(
    () =>
      db.recordReviewRun({
        tenantId: tenant.id,
        installationId: 1,
        owner: 'integrity',
        repo: 'api',
        pr: 1,
        headSha: 'sha',
        action: 'manual',
        status: 'completed',
        durationMs: -1,
      }),
    /check constraint violation|CHECK constraint failed/,
  );
});

test('provider attempts persist retry lineage and terminal review cleanup', () => {
  const db = freshDb();
  const tenant = db.createTenant('attempts');
  const runId = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'attempts',
    repo: 'api',
    pr: 2,
    headSha: 'sha',
    action: 'manual',
  });
  const startedAt = new Date().toISOString();
  db.startReviewRunAttempt({
    id: 'attempt-1',
    runId,
    tenantId: tenant.id,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    tier: 'openai',
    passName: 'breadth',
    transport: 'codex-cli',
    retryIndex: 0,
    keyIndex: 0,
    startedAt,
  });
  db.startReviewRunAttempt({
    id: 'attempt-2',
    runId,
    tenantId: tenant.id,
    parentAttemptId: 'attempt-1',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    tier: 'openai',
    passName: 'breadth',
    transport: 'codex-cli',
    retryIndex: 1,
    keyIndex: 0,
    startedAt,
  });
  assert.equal(
    db.completeReviewRunAttempt({
      id: 'attempt-1',
      outcome: 'rate_limited',
      durationMs: 12,
      completedAt: new Date().toISOString(),
      error: 'rate limited',
    }),
    true,
  );
  assert.equal(
    db.completeReviewRunAttempt({
      id: 'attempt-1',
      outcome: 'failed',
      durationMs: 15,
      completedAt: new Date().toISOString(),
    }),
    false,
    'attempt completion is compare-and-swap',
  );
  db.completeReviewRun(runId, { status: 'failed', durationMs: 20, error: 'provider exhausted' });

  const attempts = db.listReviewRunAttempts(runId);
  assert.equal(attempts[0]?.outcome, 'rate_limited');
  assert.equal(attempts[1]?.parentAttemptId, 'attempt-1');
  assert.equal(attempts[1]?.outcome, 'failed', 'terminal review closes dangling attempts');
  assert.ok(attempts[1]?.completedAt);
  assert.ok(db.listReviewRuns(tenant.id, 1)[0]?.completedAt);
  assert.throws(
    () =>
      db.startReviewRunAttempt({
        id: 'attempt-bad-lineage',
        runId,
        tenantId: tenant.id,
        parentAttemptId: 'missing',
        provider: 'openai',
        model: 'gpt-5.6-luna',
        tier: 'openai',
        transport: 'codex-cli',
        retryIndex: 2,
        keyIndex: 0,
        startedAt,
      }),
    /lineage mismatch/,
  );
});

test('usage and retry lineage cannot cross review-run boundaries', () => {
  const db = freshDb();
  const tenant = db.createTenant('lineage');
  const firstRun = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'lineage',
    repo: 'api',
    pr: 1,
    headSha: 'sha-1',
    action: 'manual',
  });
  const secondRun = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'lineage',
    repo: 'api',
    pr: 2,
    headSha: 'sha-2',
    action: 'manual',
  });
  db.startReviewRunAttempt({
    id: 'first-run-attempt',
    runId: firstRun,
    tenantId: tenant.id,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    tier: 'deepseek-flash',
    transport: 'chat',
    retryIndex: 0,
    keyIndex: 0,
    startedAt: new Date().toISOString(),
  });

  assert.throws(
    () =>
      db.startReviewRunAttempt({
        id: 'cross-run-child',
        runId: secondRun,
        tenantId: tenant.id,
        parentAttemptId: 'first-run-attempt',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        tier: 'deepseek-flash',
        transport: 'chat',
        retryIndex: 1,
        keyIndex: 0,
        startedAt: new Date().toISOString(),
      }),
    /lineage mismatch/,
  );
  assert.throws(
    () =>
      db.recordReviewRunUsage({
        runId: secondRun,
        tenantId: tenant.id,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        tier: 'deepseek-flash',
        inputTokens: 1,
        outputTokens: 1,
        inputRatePerM: 1,
        outputRatePerM: 1,
        costUsd: 0.000002,
        tokenSource: 'provider',
        attemptId: 'first-run-attempt',
      }),
    /usage attempt lineage mismatch/,
  );
});

test('interruptReviewRun marks running rows so resumeReviewRun can reopen them', () => {
  const db = freshDb();
  const tenant = db.createTenant('interrupt');
  const input = {
    tenantId: tenant.id,
    installationId: 9,
    owner: 'interrupt',
    repo: 'api',
    pr: 3,
    headSha: 'abc',
    action: 'synchronize' as const,
  };
  const runId = db.startReviewRun(input);
  db.startReviewRunAttempt({
    id: 'interrupted-attempt',
    runId,
    tenantId: tenant.id,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    tier: 'openai',
    transport: 'codex-cli',
    retryIndex: 0,
    keyIndex: 0,
    startedAt: new Date().toISOString(),
  });
  assert.equal(db.interruptReviewRun(runId), true);
  assert.equal(db.interruptReviewRun(runId), false, 'already interrupted');
  assert.equal(db.listReviewRuns(tenant.id, 1)[0]?.skipReason, 'interrupted by restart');
  assert.equal(db.listReviewRunAttempts(runId)[0]?.outcome, 'cancelled');
  assert.equal(
    db.resumeReviewRun(runId, {
      tenantId: input.tenantId,
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      pr: input.pr,
      action: input.action,
    }),
    'resumed',
  );
});

test('review-run lifecycle writes are fenced to the worker that owns the running row', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-store-ownership-'));
  try {
    const dbPath = path.join(directory, 'shared.db');
    const staleWorker = new AppDatabase(dbPath, 'worker-a');
    const activeWorker = new AppDatabase(dbPath, 'worker-b');
    const tenant = staleWorker.createTenant('ownership');
    const runInput = {
      tenantId: tenant.id,
      installationId: 9,
      owner: 'ownership',
      repo: 'api',
      pr: 3,
      headSha: 'original-sha',
      action: 'synchronize',
    };
    const runId = staleWorker.startReviewRun(runInput);

    assert.equal(staleWorker.interruptReviewRun(runId), true);
    assert.equal(activeWorker.resumeReviewRun(runId, runInput), 'resumed');
    assert.equal(activeWorker.setReviewRunHeadSha(runId, 'replacement-sha'), true);

    assert.equal(staleWorker.setReviewRunHeadSha(runId, 'stale-sha'), false);
    assert.equal(staleWorker.interruptReviewRun(runId), false);
    assert.equal(
      staleWorker.completeReviewRun(runId, {
        status: 'failed',
        durationMs: 1,
        error: 'stale worker',
      }),
      false,
    );

    assert.equal(
      activeWorker.startReviewRunAttempt({
        id: 'replacement-attempt',
        runId,
        tenantId: tenant.id,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        tier: 'deepseek-flash',
        transport: 'chat',
        retryIndex: 0,
        keyIndex: 0,
        startedAt: new Date().toISOString(),
      }),
      true,
    );
    assert.equal(
      staleWorker.completeReviewRunAttempt({
        id: 'replacement-attempt',
        outcome: 'failed',
        durationMs: 1,
        completedAt: new Date().toISOString(),
        error: 'stale worker',
      }),
      false,
    );
    assert.equal(
      staleWorker.recordReviewRunUsage({
        runId,
        tenantId: tenant.id,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        tier: 'deepseek-flash',
        inputTokens: 1,
        outputTokens: 1,
        inputRatePerM: 1,
        outputRatePerM: 1,
        costUsd: 0.000002,
        tokenSource: 'provider',
        attemptId: 'replacement-attempt',
      }),
      null,
    );

    const run = activeWorker.listReviewRuns(tenant.id, 1)[0]!;
    assert.equal(run.status, 'running');
    assert.equal(run.headSha, 'replacement-sha');
    assert.equal(activeWorker.listReviewRunAttempts(runId)[0]?.outcome, 'running');
    assert.deepEqual(activeWorker.listReviewRunUsage(runId), []);

    assert.equal(
      activeWorker.completeReviewRun(runId, { status: 'completed', durationMs: 2 }),
      true,
    );
    assert.equal(staleWorker.completeReviewRun(runId, { status: 'failed', durationMs: 3 }), false);
    assert.equal(activeWorker.listReviewRuns(tenant.id, 1)[0]?.status, 'completed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('durable storage rejects database files anywhere inside the checkout', () => {
  assert.throws(
    () =>
      new AppDatabase({
        databasePath: path.join(process.cwd(), 'velatrix-review.db'),
        workerIdBase: 'durability-test',
        checkoutRoot: process.cwd(),
        requireDurableStorage: true,
        defaultPlan: 'free',
      }),
    /outside the checkout/,
  );
});

test('installation upsert never rebinds an existing installation to another tenant', () => {
  const db = freshDb();
  const first = db.createTenant('first');
  const second = db.createTenant('second');
  db.upsertInstallation({
    installationId: 7,
    tenantId: first.id,
    accountLogin: 'org',
    accountType: 'Organization',
  });
  const result = db.upsertInstallation({
    installationId: 7,
    tenantId: second.id,
    accountLogin: 'org-renamed',
    accountType: 'Organization',
  });
  assert.equal(result.tenantId, first.id);
  assert.equal(result.accountLogin, 'org-renamed');
});

test('sessions: valid session resolves user, expired session is rejected', () => {
  const db = freshDb();
  const user = db.upsertUserFromGitHub({ githubId: 1, login: 'alice' });

  const live = db.createSession(user.id);
  assert.equal(db.getSessionUser(live.id)?.id, user.id);

  const expired = db.createSession(user.id, -1000);
  assert.equal(db.getSessionUser(expired.id), null);

  db.deleteSession(live.id);
  assert.equal(db.getSessionUser(live.id), null);
});

test('membership: owners, member listing, member-less tenants are claimable', () => {
  const db = freshDb();
  const alice = db.upsertUserFromGitHub({ githubId: 1, login: 'alice' });
  const bob = db.upsertUserFromGitHub({ githubId: 2, login: 'bob' });
  const tenant = db.createTenant('acme', 'Acme Corp');

  assert.equal(db.tenantHasMembers(tenant.id), false);
  db.addWorkspaceMember(tenant.id, alice.id, 'owner');
  assert.equal(db.tenantHasMembers(tenant.id), true);

  assert.equal(db.getMembership(tenant.id, alice.id)?.role, 'owner');
  assert.equal(db.getMembership(tenant.id, bob.id), null);

  const workspaces = db.getWorkspacesForUser(alice.id);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].tenant.slug, 'acme');
  assert.equal(workspaces[0].role, 'owner');
});

test('paid access downgrades on explicit dunning status and durable webhook claims dedupe across workers', () => {
  const db = freshDb();
  const tenant = db.createTenant('billing');
  db.setTenantPlan(tenant.id, 'review');
  db.setTenantBilling(tenant.id, { stripeSubscriptionStatus: 'past_due' });
  assert.equal(db.getTenantPlan(tenant.id), 'free');

  db.setTenantBilling(tenant.id, { stripeSubscriptionStatus: 'active' });
  assert.equal(db.getTenantPlan(tenant.id), 'review');

  const stripeClaim = db.claimWebhookEvent('stripe', 'evt_1');
  assert.ok(stripeClaim);
  assert.equal(db.claimWebhookEvent('stripe', 'evt_1'), null);
  db.completeWebhookEvent('stripe', 'evt_1', stripeClaim);
  assert.equal(db.claimWebhookEvent('stripe', 'evt_1'), null);
  assert.ok(
    db.claimWebhookEvent('github', 'evt_1'),
    'providers use independent delivery namespaces',
  );

  const runId = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 7,
    owner: 'billing',
    repo: 'api',
    pr: 1,
    headSha: 'abc',
    action: 'synchronize',
  });
  assert.equal(db.failStaleRunningRuns({ staleAfterMs: 60_000, nowMs: Date.now() + 61_000 }), 1);
  assert.equal(
    db.countAccountReviews('billing'),
    1,
    'an interrupted attempt remains quota-consuming',
  );
  assert.equal(
    db.resumeReviewRun(runId, {
      tenantId: tenant.id,
      installationId: 7,
      owner: 'billing',
      repo: 'api',
      pr: 1,
      action: 'synchronize',
    }),
    'resumed',
  );
  db.completeReviewRun(runId, { status: 'completed', durationMs: 1 });
  assert.equal(
    db.resumeReviewRun(runId, {
      tenantId: tenant.id,
      installationId: 7,
      owner: 'billing',
      repo: 'api',
      pr: 1,
      action: 'synchronize',
    }),
    'completed',
  );
});

test('retention removes abandoned webhook claims so the event ledger stays bounded', () => {
  const db = freshDb();
  const firstClaim = db.claimWebhookEvent('github', 'stale-event');
  assert.ok(firstClaim);
  const old = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
  (
    db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }
  ).db
    .prepare(`UPDATE webhook_events SET claimed_at = ?`)
    .run(old);

  assert.equal(db.pruneEphemeralData(), 1);
  const reclaimed = db.claimWebhookEvent('github', 'stale-event');
  assert.ok(reclaimed);
  assert.notEqual(reclaimed, firstClaim);
  db.completeWebhookEvent('github', 'stale-event', firstClaim);
  assert.equal(db.getWebhookEvent('github', 'stale-event')?.processedAt, undefined);
  db.completeWebhookEvent('github', 'stale-event', reclaimed);
  assert.ok(db.getWebhookEvent('github', 'stale-event')?.processedAt);
});

test('body-hash claims dedupe replays inside the TTL and reopen after it', () => {
  const db = freshDb();
  const hash = 'a'.repeat(64);
  const first = db.claimWebhookBodyHash('github', hash, { ttlMs: 60_000 });
  assert.ok(first);
  assert.equal(
    db.claimWebhookBodyHash('github', hash, { ttlMs: 60_000 }),
    null,
    'in-flight blocks',
  );
  db.completeWebhookEvent(db.webhookBodyProvider('github'), hash, first);
  assert.equal(
    db.claimWebhookBodyHash('github', hash, { ttlMs: 60_000 }),
    null,
    'processed body hash blocks inside TTL',
  );

  const expired = new Date(Date.now() - 120_000).toISOString();
  (
    db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }
  ).db
    .prepare(
      `UPDATE webhook_events SET processed_at = ?, claimed_at = ? WHERE provider = ? AND event_id = ?`,
    )
    .run(expired, expired, db.webhookBodyProvider('github'), hash);

  const afterTtl = db.claimWebhookBodyHash('github', hash, { ttlMs: 60_000 });
  assert.ok(afterTtl, 'TTL expiry allows a fresh claim');
  assert.notEqual(afterTtl, first);
});

test('review runs: recorded and aggregated into workspace stats', () => {
  const db = freshDb();
  const tenant = db.createTenant('acme');

  const base = {
    tenantId: tenant.id,
    installationId: 100,
    owner: 'acme',
    repo: 'api',
    pr: 1,
    headSha: 'abc1234',
    action: 'opened',
  };

  db.recordReviewRun({
    ...base,
    status: 'completed',
    durationMs: 1000,
    findingsNew: 3,
    findingsFixed: 1,
    findingsOpen: 3,
  });
  db.recordReviewRun({
    ...base,
    pr: 2,
    status: 'completed',
    durationMs: 3000,
    findingsNew: 1,
    findingsFixed: 2,
    findingsOpen: 0,
  });
  db.recordReviewRun({ ...base, pr: 3, status: 'skipped', skipReason: 'draft', durationMs: 50 });
  db.recordReviewRun({ ...base, pr: 4, status: 'failed', error: 'boom', durationMs: 200 });

  const runs = db.listReviewRuns(tenant.id);
  assert.equal(runs.length, 4);
  assert.equal(runs.filter((r) => r.status === 'completed').length, 2);
  assert.equal(runs.find((r) => r.status === 'skipped')?.skipReason, 'draft');

  const stats = db.getWorkspaceStats(tenant.id, 14);
  assert.equal(stats.runsTotal, 4);
  assert.equal(stats.runsCompleted, 2);
  assert.equal(stats.runsSkipped, 1);
  assert.equal(stats.runsFailed, 1);
  assert.equal(stats.findingsNew, 4);
  assert.equal(stats.findingsFixed, 3);
  // avg duration only counts completed runs
  assert.equal(stats.avgDurationMs, 2000);

  // other tenants see nothing
  const other = db.createTenant('other');
  assert.equal(db.getWorkspaceStats(other.id, 14).runsTotal, 0);
  assert.equal(db.listReviewRuns(other.id).length, 0);
});

test('review runs: setReviewRunHeadSha re-points a run at the effective SHA', () => {
  const db = freshDb();
  const tenant = db.createTenant('acme');
  const runId = db.startReviewRun({
    tenantId: tenant.id,
    installationId: 1,
    owner: 'acme',
    repo: 'api',
    pr: 7,
    headSha: 'stale-sha-from-webhook',
    action: 'synchronize',
  });
  // The PR head moved between enqueue and execution — record on the real SHA.
  db.setReviewRunHeadSha(runId, 'effective-sha');
  db.completeReviewRun(runId, { status: 'completed', durationMs: 10 });

  // Cooldown keys on head_sha: the EFFECTIVE sha must hit, the stale one must not.
  assert.notEqual(db.secondsSinceLastCompletedReview(1, 'acme', 'api', 7, 'effective-sha'), null);
  assert.equal(
    db.secondsSinceLastCompletedReview(1, 'acme', 'api', 7, 'stale-sha-from-webhook'),
    null,
  );
});

test('repos: upsert refreshes tenant_id when an installation is re-linked', () => {
  const db = freshDb();
  const t1 = db.createTenant('one');
  const t2 = db.createTenant('two');
  const base = {
    installationId: 7,
    githubRepoId: 99,
    owner: 'acme',
    name: 'api',
    fullName: 'acme/api',
  };

  db.upsertRepo({ ...base, tenantId: t1.id });
  assert.equal(db.getRepoByGitHubId(7, 99)?.tenantId, t1.id);

  // installation re-linked to a different tenant → the repo must follow
  db.upsertRepo({ ...base, tenantId: t2.id });
  assert.equal(db.getRepoByGitHubId(7, 99)?.tenantId, t2.id);
  assert.equal(db.listRepos(t1.id).length, 0);
  assert.equal(db.listRepos(t2.id).length, 1);

  assert.equal(db.disableRepoByGitHubId(7, 99), true);
  assert.equal(db.getRepoByGitHubId(7, 99)?.enabled, false);
  assert.equal(
    db.disableReposForInstallation(7),
    0,
    'already-disabled repos are not counted twice',
  );
});

test('manual-review candidates round-trip separately from findings', () => {
  // They are persisted ONLY so `@orvex ignore <file>:<line>` can resolve them:
  // a manual candidate has no inline comment, so the thread-reply form of
  // `ignore` (which matches on githubCommentId) could never reach it and the
  // noise repeated on every push forever. They must stay OUT of `findings` so
  // they never reach the dashboard projection or the new/open/fixed stats.
  const db = freshDb();
  const key = { installationId: 1, owner: 'o', repo: 'r', pr: 5 };
  db.saveState({
    installationId: 1,
    tenantId: 't',
    owner: 'o',
    repo: 'r',
    pr: 5,
    lastSha: 'sha1',
    findings: [],
    lastReviewAt: new Date().toISOString(),
    manualReview: [
      {
        id: 'm1',
        fingerprint: 'fp-manual-1',
        file: 'src/a.ts',
        line: 42,
        severity: 'P1',
        category: 'logic',
        message: 'unconfirmed candidate',
        confidence: 0.3,
        ruleId: 'llm.general',
        status: 'open',
        firstSeenSha: 'sha1',
      } as never,
    ],
  });
  const back = db.getState(key);
  assert.equal(back?.manualReview?.length, 1);
  assert.equal(back?.manualReview?.[0]?.fingerprint, 'fp-manual-1');
  assert.deepEqual(back?.findings, [], 'manual candidates must not leak into findings');
});

test('a pr_reviews row written before manual_review_json existed still loads', () => {
  // Guards the ALTER-TABLE migration: the live DB predates this column, and a
  // failure here would break every existing PR's state on deploy.
  const db = freshDb();
  const key = { installationId: 2, owner: 'o', repo: 'r', pr: 7 };
  db.saveState({
    installationId: 2,
    tenantId: 't',
    owner: 'o',
    repo: 'r',
    pr: 7,
    lastSha: 'sha1',
    findings: [],
    lastReviewAt: new Date().toISOString(),
  });
  const back = db.getState(key);
  assert.ok(back, 'state without manualReview must still load');
  assert.equal(back?.manualReview, undefined);
});
