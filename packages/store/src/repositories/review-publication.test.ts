import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AppDatabase } from '../database.js';
import { STORE_MIGRATIONS } from '../migrations.js';

function startOwnedRun(database: AppDatabase, tenantId: string): string {
  return database.startReviewRun({
    tenantId,
    installationId: 42,
    owner: 'acme',
    repo: 'api',
    pr: 7,
    headSha: 'abc123',
    action: 'opened',
  });
}

test('review publication claims are tenant scoped, token fenced, and replay published results', () => {
  const database = new AppDatabase(':memory:', 'worker-a');
  const tenant = database.createTenant('publication-claims');
  const runId = startOwnedRun(database, tenant.id);
  const scope = { tenantId: tenant.id, runId, artifactKey: 'review:abc123' };

  const claim = database.claimReviewPublication(scope);
  assert.equal(claim.status, 'claimed');
  if (claim.status !== 'claimed') throw new Error('expected publication claim');

  assert.equal(
    database.completeReviewPublication({
      ...scope,
      claimToken: 'wrong-token',
      resultJson: '{"reviewId":9}',
    }),
    false,
  );
  assert.equal(
    database.completeReviewPublication({
      ...scope,
      claimToken: claim.claimToken,
      resultJson: '{"reviewId":9}',
    }),
    true,
  );
  assert.deepEqual(database.claimReviewPublication(scope), {
    status: 'published',
    resultJson: '{"reviewId":9}',
  });
  assert.deepEqual(database.claimReviewPublication({ ...scope, tenantId: 'wrong-tenant' }), {
    status: 'not_owner',
  });
  database.close();
});

test('known failed publication claims are released, while an ownership handoff cannot complete one', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-publication-claims-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const workerA = new AppDatabase(dbPath, 'worker-a');
    const tenant = workerA.createTenant('publication-retry');
    const runId = startOwnedRun(workerA, tenant.id);
    const scope = { tenantId: tenant.id, runId, artifactKey: 'check:abc123' };
    const first = workerA.claimReviewPublication(scope);
    assert.equal(first.status, 'claimed');
    if (first.status !== 'claimed') throw new Error('expected first publication claim');
    assert.equal(
      workerA.releaseReviewPublication({ ...scope, claimToken: first.claimToken }),
      true,
    );
    const second = workerA.claimReviewPublication(scope);
    assert.equal(second.status, 'claimed');
    if (second.status !== 'claimed') throw new Error('expected retry publication claim');

    const workerB = new AppDatabase(dbPath, 'worker-b');
    assert.equal(workerA.interruptReviewRun(runId), true);
    assert.equal(
      workerB.resumeReviewRun(runId, {
        tenantId: tenant.id,
        installationId: 42,
        owner: 'acme',
        repo: 'api',
        pr: 7,
        action: 'opened',
      }),
      'resumed',
    );
    assert.equal(
      workerA.completeReviewPublication({
        ...scope,
        claimToken: second.claimToken,
        resultJson: 'null',
      }),
      false,
    );
    assert.equal(workerB.claimReviewPublication(scope).status, 'in_progress');
    workerB.close();
    workerA.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('operators can resolve only abandoned claims and every decision is immutable and auditable', () => {
  const database = new AppDatabase(':memory:', 'worker-a');
  const tenant = database.createTenant('publication-operator');
  const activeRun = startOwnedRun(database, tenant.id);
  const activeScope = {
    tenantId: tenant.id,
    runId: activeRun,
    artifactKey: 'fixed-reply:comment-1',
  };
  assert.equal(database.claimReviewPublication(activeScope).status, 'claimed');
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  assert.deepEqual(database.listAbandonedReviewPublications(cutoff), []);
  assert.equal(
    database.resolveAbandonedReviewPublication({
      ...activeScope,
      action: 'retry',
      actor: 'operator:test',
      reason: 'GitHub confirms the request was rejected',
      abandonedBefore: cutoff,
    }),
    false,
  );

  assert.equal(database.interruptReviewRun(activeRun), true);
  assert.equal(
    database.listAbandonedReviewPublications(cutoff)[0]?.artifactKey,
    activeScope.artifactKey,
  );
  assert.equal(
    database.resolveAbandonedReviewPublication({
      ...activeScope,
      action: 'retry',
      actor: 'operator:test',
      reason: 'GitHub confirms the request was rejected',
      abandonedBefore: cutoff,
    }),
    true,
  );

  const publishedRun = startOwnedRun(database, tenant.id);
  const publishedScope = { tenantId: tenant.id, runId: publishedRun, artifactKey: 'review:abc123' };
  assert.equal(database.claimReviewPublication(publishedScope).status, 'claimed');
  assert.equal(database.interruptReviewRun(publishedRun), true);
  assert.equal(
    database.resolveAbandonedReviewPublication({
      ...publishedScope,
      action: 'mark_published',
      actor: 'operator:test',
      reason: 'Verified review 91 on GitHub',
      abandonedBefore: cutoff,
      resultJson:
        '{"reviewId":91,"reviewUrl":"https://github.com/acme/api/pull/7#pullrequestreview-91","commentIds":[]}',
    }),
    true,
  );
  assert.equal(database.claimReviewPublication(publishedScope).status, 'published');

  const resolutions = database.listReviewPublicationResolutions();
  assert.deepEqual(resolutions.map(({ action }) => action).sort(), ['mark_published', 'retry']);
  assert.equal(
    resolutions.every(({ actor, reason }) => actor === 'operator:test' && reason.length > 0),
    true,
  );
  const raw = (
    database as unknown as {
      db: { prepare: (sql: string) => { run: (...values: unknown[]) => unknown } };
    }
  ).db;
  assert.throws(
    () => raw.prepare('UPDATE review_publication_resolutions SET reason = ?').run('rewritten'),
    /publication resolution audit is immutable/,
  );
  assert.throws(
    () => raw.prepare('DELETE FROM review_publication_resolutions').run(),
    /publication resolution audit is immutable/,
  );
  database.close();
});

test('a v15 database receives the immutable publication-claim migration without rewriting history', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-publication-migration-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const current = new AppDatabase(dbPath, 'worker-a');
    const tenant = current.createTenant('publication-history');
    const runId = startOwnedRun(current, tenant.id);
    const raw = (
      current as unknown as {
        db: {
          exec: (sql: string) => void;
          prepare: (sql: string) => {
            run: (...values: unknown[]) => unknown;
            all: () => unknown[];
          };
        };
      }
    ).db;
    raw.exec('DROP TABLE review_publication_resolutions');
    raw.exec('DROP TABLE review_publications');
    raw.prepare('DELETE FROM orvex_schema_migrations WHERE version >= 16').run();
    current.close();

    const upgraded = new AppDatabase(dbPath, 'worker-a');
    assert.equal(
      upgraded.claimReviewPublication({ tenantId: tenant.id, runId, artifactKey: 'review:abc123' })
        .status,
      'claimed',
    );
    const versions = (
      upgraded as unknown as {
        db: { prepare: (sql: string) => { all: () => Array<{ version: number }> } };
      }
    ).db
      .prepare('SELECT version FROM orvex_schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version);
    assert.deepEqual(
      versions,
      STORE_MIGRATIONS.map((migration) => migration.version),
    );
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a v16 database gains operator resolution audit without losing an in-progress claim', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orvex-publication-audit-migration-'));
  try {
    const dbPath = path.join(directory, 'store.db');
    const current = new AppDatabase(dbPath, 'worker-a');
    const tenant = current.createTenant('publication-audit-history');
    const runId = startOwnedRun(current, tenant.id);
    const scope = { tenantId: tenant.id, runId, artifactKey: 'check:abc123' };
    assert.equal(current.claimReviewPublication(scope).status, 'claimed');
    const raw = (
      current as unknown as {
        db: {
          exec: (sql: string) => void;
          prepare: (sql: string) => { run: (...values: unknown[]) => unknown };
        };
      }
    ).db;
    raw.exec('DROP TABLE review_publication_resolutions');
    raw.prepare('DELETE FROM orvex_schema_migrations WHERE version = 17').run();
    current.close();

    const upgraded = new AppDatabase(dbPath, 'worker-b');
    assert.equal(upgraded.claimReviewPublication(scope).status, 'in_progress');
    assert.equal(
      upgraded.listAbandonedReviewPublications(new Date().toISOString())[0]?.artifactKey,
      scope.artifactKey,
    );
    assert.equal(
      upgraded.resolveAbandonedReviewPublication({
        ...scope,
        action: 'retry',
        actor: 'operator:migration-test',
        reason: 'Confirmed no external check exists',
        abandonedBefore: new Date().toISOString(),
      }),
      true,
    );
    assert.equal(upgraded.listReviewPublicationResolutions()[0]?.action, 'retry');
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
