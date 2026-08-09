import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppDatabase } from '../database.js';
import { SqliteIdentityRepository } from './identity.js';
import { SqliteBillingRepository } from './billing.js';
import { SqliteMaintenanceRepository } from './maintenance.js';
import { RepositoryReadRepository } from './repository-read.js';
import { SqliteRepositoryWriteRepository } from './repository-write.js';
import { SqliteReviewStateRepository } from './review-state.js';
import { SqliteTenancyRepository } from './tenancy.js';
import { WorkspaceReadRepository } from './workspace-read.js';

function repositories(db: AppDatabase): {
  identity: SqliteIdentityRepository;
  tenancy: SqliteTenancyRepository;
} {
  const raw = (db as unknown as { db: ConstructorParameters<typeof SqliteIdentityRepository>[0] })
    .db;
  return {
    identity: new SqliteIdentityRepository(raw),
    tenancy: new SqliteTenancyRepository(raw, 'free'),
  };
}

function reviewStateRepository(
  db: AppDatabase,
  workerId = 'review-state-test-worker',
): SqliteReviewStateRepository {
  const raw = (
    db as unknown as { db: ConstructorParameters<typeof SqliteReviewStateRepository>[0] }
  ).db;
  return new SqliteReviewStateRepository(
    raw,
    {
      getRepoByFullName: () => null,
      getInstallation: () => null,
      getWorkspaceSettings: (tenantId) => ({
        tenantId,
        defaultReviewMode: 'normal',
        autoApplyDefault: false,
        minConfidence: 0.6,
        maxComments: 8,
        autoEnableNewRepos: true,
        updatedAt: new Date().toISOString(),
      }),
    },
    { debitOverageCredits: () => true },
    workerId,
  );
}

function mutableRepositories(db: AppDatabase): {
  billing: SqliteBillingRepository;
  maintenance: SqliteMaintenanceRepository;
  repositoryWrites: SqliteRepositoryWriteRepository;
} {
  const raw = (db as unknown as { db: ConstructorParameters<typeof SqliteBillingRepository>[0] })
    .db;
  const repositoryReads = new RepositoryReadRepository(raw);
  const workspaceReads = new WorkspaceReadRepository(raw);
  return {
    billing: new SqliteBillingRepository(raw, { listReviewRunUsage: () => [] }),
    maintenance: new SqliteMaintenanceRepository(raw, 'maintenance-test-worker'),
    repositoryWrites: new SqliteRepositoryWriteRepository(raw, {
      getRepoByGitHubId: (installationId, githubRepoId) =>
        repositoryReads.getByGitHubId(installationId, githubRepoId),
      getRepoByFullName: (installationId, fullName) =>
        repositoryReads.getByFullName(installationId, fullName),
      getWorkspaceSettings: (tenantId) => workspaceReads.getWorkspaceSettings(tenantId),
    }),
  };
}

test('identity repository preserves OAuth linking and rotates sessions atomically during MFA enrollment', () => {
  const db = new AppDatabase(':memory:');
  const { identity } = repositories(db);
  const passwordUser = identity.createPasswordUser({
    email: 'person@example.com',
    passwordHash: 'hash',
  });
  assert.ok(passwordUser);
  assert.equal(identity.setUserEmailVerified(passwordUser.id), true);
  const linked = identity.upsertUserFromGitHub({
    githubId: 42,
    login: 'person',
    email: 'person@example.com',
  });
  assert.equal(linked.id, passwordUser.id, 'OAuth links the verified existing account');

  const oldSession = identity.createSession(linked.id);
  assert.equal(identity.setPendingTotpSecret(linked.id, 'encrypted-secret'), true);
  const rotated = identity.completeTotpEnrollment({
    userId: linked.id,
    expectedEncryptedSecret: 'encrypted-secret',
    totpEpoch: 100,
    recoveryCodeHashes: ['recovery-hash'],
  });
  assert.ok(rotated);
  assert.equal(
    identity.getSessionUser(oldSession.id),
    null,
    'existing sessions are removed in the enrollment transaction',
  );
  assert.equal(identity.getSessionUser(rotated.id)?.id, linked.id);
  assert.equal(identity.getUserSecurity(linked.id).totpEnabled, true);

  assert.deepEqual(
    identity.consumeAuthAttempt(`mfa:${linked.id}`, { windowMs: 60_000, max: 1 }, 1_000),
    { allowed: true, retryAfterSeconds: 0 },
  );
  assert.equal(
    identity.consumeAuthAttempt(`mfa:${linked.id}`, { windowMs: 60_000, max: 1 }, 1_001).allowed,
    false,
  );
  identity.clearMfaAttempts(linked.id);
  assert.equal(
    identity.consumeMfaAttempt(linked.id, { windowMs: 60_000, max: 1 }, 1_002).allowed,
    true,
  );
  db.close();
});

test('tenancy repository scopes memberships and makes installation ownership immutable', () => {
  const db = new AppDatabase(':memory:');
  const { identity, tenancy } = repositories(db);
  const first = tenancy.createTenant('first-workspace');
  const second = tenancy.createTenant('second-workspace');
  const user = identity.upsertPasswordUser({ email: 'member@example.com', passwordHash: 'hash' });

  const firstInstall = tenancy.upsertInstallation({
    installationId: 77,
    tenantId: first.id,
    accountLogin: 'first',
    accountType: 'Organization',
  });
  const attemptedRebind = tenancy.upsertInstallation({
    installationId: 77,
    tenantId: second.id,
    accountLogin: 'renamed',
    accountType: 'Organization',
  });
  assert.equal(firstInstall.tenantId, first.id);
  assert.equal(
    attemptedRebind.tenantId,
    first.id,
    'an installation cannot be rebound to another tenant',
  );
  assert.equal(tenancy.getInstallationsForTenant(second.id).length, 0);
  assert.equal(tenancy.tenantIsClaimable(second.id), true);
  tenancy.addWorkspaceMember(second.id, user.id, 'owner');
  assert.equal(tenancy.getMembership(first.id, user.id), null);
  assert.equal(tenancy.getMembership(second.id, user.id)?.role, 'owner');
  assert.equal(tenancy.tenantIsClaimable(second.id), false);
  assert.equal(
    tenancy
      .getWorkspacesForUser(user.id)
      .map(({ tenant }) => tenant.id)
      .includes(second.id),
    true,
  );
  db.close();
});

test('review state repository fences lifecycle writes to the owning worker and tenant', () => {
  const db = new AppDatabase(':memory:', 'facade-worker');
  const tenant = db.createTenant('review-state-tenant');
  const owner = reviewStateRepository(db, 'owning-worker');
  const other = reviewStateRepository(db, 'other-worker');
  const runId = owner.startReviewRun({
    tenantId: tenant.id,
    installationId: 11,
    owner: 'org',
    repo: 'service',
    pr: 4,
    headSha: 'sha',
    action: 'opened',
  });

  assert.equal(other.setReviewRunHeadSha(runId, 'new-sha'), false);
  assert.equal(other.completeReviewRun(runId, { status: 'completed', durationMs: 1 }), false);
  assert.throws(
    () =>
      other.recordReviewRunUsage({
        runId,
        tenantId: 'another-tenant',
        provider: 'test',
        model: 'test-model',
        tier: 'test',
        inputTokens: 1,
        outputTokens: 1,
        inputRatePerM: 0,
        outputRatePerM: 0,
        costUsd: 0,
        tokenSource: 'unknown',
      }),
    /tenant mismatch/,
  );

  assert.ok(
    owner.recordReviewRunUsage({
      runId,
      tenantId: tenant.id,
      provider: 'test',
      model: 'test-model',
      tier: 'test',
      inputTokens: 1,
      outputTokens: 1,
      inputRatePerM: 0,
      outputRatePerM: 0,
      costUsd: 0,
      tokenSource: 'unknown',
    }),
  );
  assert.equal(owner.completeReviewRun(runId, { status: 'completed', durationMs: 1 }), true);
  assert.equal(owner.listReviewRunUsage(runId).length, 1);
  db.close();
});

test('billing repository keeps prepaid debits idempotent and Stripe meter records tenant-bound', () => {
  const db = new AppDatabase(':memory:');
  const { billing } = mutableRepositories(db);
  const tenant = db.createTenant('billing-repository');
  assert.deepEqual(
    billing.creditPrepaidTopUp({
      tenantId: tenant.id,
      amountCents: 250,
      stripeSessionId: 'checkout-1',
    }),
    { applied: true, balanceCents: 250 },
  );
  assert.equal(billing.debitOverageCredits(tenant.id, 'run-1', 50), true);
  assert.equal(
    billing.debitOverageCredits(tenant.id, 'run-1', 50),
    true,
    'run id makes debits idempotent',
  );
  assert.equal(billing.getCreditBalanceCents(tenant.id), 200);
  const meter = billing.enqueueStripeMeterEvent({
    runId: 'run-1',
    tenantId: tenant.id,
    customerId: 'cus_test',
    eventName: 'review_overage',
    plan: 'review',
    units: 1,
  });
  assert.equal(meter.tenantId, tenant.id);
  assert.equal(billing.getStripeMeterEvent('run-1')?.status, 'pending');
  db.close();
});

test('repository-write and maintenance repositories retain installation and platform boundaries', () => {
  const db = new AppDatabase(':memory:');
  const { maintenance, repositoryWrites } = mutableRepositories(db);
  const tenant = db.createTenant('repository-write');
  db.upsertInstallation({
    installationId: 91,
    tenantId: tenant.id,
    accountLogin: 'workspace',
    accountType: 'Organization',
  });
  const repo = repositoryWrites.upsertRepo({
    installationId: 91,
    tenantId: tenant.id,
    githubRepoId: 200,
    owner: 'workspace',
    name: 'api',
    fullName: 'workspace/api',
  });
  assert.equal(repositoryWrites.isRepoEnabled(91, 'workspace/api'), true);
  repositoryWrites.setRepoEnabled(repo.id, false);
  assert.equal(repositoryWrites.isRepoEnabled(91, 'workspace/api'), false);
  assert.equal(
    repositoryWrites.listScanTargets().length,
    0,
    'disabled repositories are excluded from platform scans',
  );

  const claim = maintenance.claimWebhookEvent('github', 'delivery-1');
  assert.ok(claim);
  assert.equal(maintenance.claimWebhookEvent('github', 'delivery-1'), null);
  maintenance.releaseWebhookEvent('github', 'delivery-1', claim!);
  assert.ok(maintenance.claimWebhookEvent('github', 'delivery-1'));
  db.close();
});
