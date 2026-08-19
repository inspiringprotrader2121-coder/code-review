import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { APP_DATABASE_COMPATIBILITY_METHODS } from './compatibility.js';

test('AppDatabase public surface is limited to the declared compatibility contract', () => {
  const source = fs.readFileSync(new URL('./database.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('database.ts', source, ts.ScriptTarget.Latest, true);
  const databaseClass = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'AppDatabase',
  );
  assert.ok(databaseClass, 'AppDatabase class must exist');

  const publicMethods = databaseClass.members
    .flatMap((member) => {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name))
        return [];
      if (member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword))
        return [];
      return [member.name.text];
    })
    .sort();

  assert.deepEqual(publicMethods, [...APP_DATABASE_COMPATIBILITY_METHODS].sort());
});

test('all AppDatabase public methods are thin declared repository delegates', () => {
  const source = fs.readFileSync(new URL('./database.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('database.ts', source, ts.ScriptTarget.Latest, true);
  const databaseClass = file.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'AppDatabase',
  );
  assert.ok(databaseClass, 'AppDatabase class must exist');

  const delegates = new Map([
    ['listReviewRuns', 'workspaceReads'],
    ['getWorkspaceStats', 'workspaceReads'],
    ['listPullRequests', 'workspaceReads'],
    ['getPullRequestCounts', 'workspaceReads'],
    ['listFindings', 'workspaceReads'],
    ['getFindingCounts', 'workspaceReads'],
    ['getWorkspaceSettings', 'workspaceReads'],
    ['getRepoByGitHubId', 'repositoryReads'],
    ['getRepoByFullName', 'repositoryReads'],
    ['listRepos', 'repositoryReads'],
    ['hasEnabledRepo', 'repositoryReads'],
    ['createTenant', 'tenancy'],
    ['getTenantBySlug', 'tenancy'],
    ['getOrCreateTenant', 'tenancy'],
    ['firstTenantSlug', 'tenancy'],
    ['getTenantById', 'tenancy'],
    ['getTenantByStripeCustomerId', 'tenancy'],
    ['listStripeCustomers', 'tenancy'],
    ['upsertInstallation', 'tenancy'],
    ['getInstallation', 'tenancy'],
    ['getInstallationsForTenant', 'tenancy'],
    ['findInstallationForRepo', 'tenancy'],
    ['addWorkspaceMember', 'tenancy'],
    ['getMembership', 'tenancy'],
    ['getWorkspacesForUser', 'tenancy'],
    ['tenantIsClaimable', 'tenancy'],
    ['tenantHasMembers', 'tenancy'],
    ['upsertUserFromGitHub', 'identity'],
    ['setUserNormalizedEmailIfMissing', 'identity'],
    ['getUserByGitHubId', 'identity'],
    ['upsertUserFromGoogle', 'identity'],
    ['getUserByGoogleId', 'identity'],
    ['getUserById', 'identity'],
    ['upsertPasswordUser', 'identity'],
    ['createPasswordUser', 'identity'],
    ['setUserEmailVerified', 'identity'],
    ['getUserByEmail', 'identity'],
    ['getUserByNormalizedEmail', 'identity'],
    ['getPasswordHash', 'identity'],
    ['setUserSuperAdmin', 'identity'],
    ['getUserSecurity', 'identity'],
    ['setPendingTotpSecret', 'identity'],
    ['enableTotp', 'identity'],
    ['completeTotpEnrollment', 'identity'],
    ['disableTotpAndRotateSession', 'identity'],
    ['regenerateRecoveryCodesAndRotateSession', 'identity'],
    ['disableTotp', 'identity'],
    ['consumeRecoveryCode', 'identity'],
    ['acceptTotpEpoch', 'identity'],
    ['consumeAuthAttempt', 'identity'],
    ['clearAuthAttempts', 'identity'],
    ['consumeMfaAttempt', 'identity'],
    ['clearMfaAttempts', 'identity'],
    ['createMfaChallenge', 'identity'],
    ['getMfaChallenge', 'identity'],
    ['consumeMfaChallenge', 'identity'],
    ['completeMfaChallenge', 'identity'],
    ['deleteMfaChallenge', 'identity'],
    ['deleteMfaChallengesForUser', 'identity'],
    ['hasPasswordUsers', 'identity'],
    ['createSession', 'identity'],
    ['getSessionUser', 'identity'],
    ['deleteSession', 'identity'],
    ['deleteSessionsForUser', 'identity'],
    ['getState', 'reviewState'],
    ['saveState', 'reviewState'],
    ['getPrSettings', 'reviewState'],
    ['setPrAutoApply', 'reviewState'],
    ['acquireFixLock', 'reviewState'],
    ['releaseFixLock', 'reviewState'],
    ['addSuppression', 'reviewState'],
    ['getSuppressedFingerprints', 'reviewState'],
    ['countRecentFixRuns', 'reviewState'],
    ['countRecentSkippedRuns', 'reviewState'],
    ['countRecentFailedRuns', 'reviewState'],
    ['recordReviewRun', 'reviewState'],
    ['startReviewRun', 'reviewState'],
    ['tryReserveReviewRun', 'reviewState'],
    ['countGlobalFreeTierReviewsSince', 'reviewState'],
    ['setReviewRunHeadSha', 'reviewState'],
    ['resumeReviewRun', 'reviewState'],
    ['completeReviewRun', 'reviewState'],
    ['startReviewRunAttempt', 'reviewState'],
    ['completeReviewRunAttempt', 'reviewState'],
    ['recordReviewRunAttemptCoverage', 'reviewState'],
    ['listReviewRunAttempts', 'reviewState'],
    ['recordReviewRunUsage', 'reviewState'],
    ['listReviewRunUsage', 'reviewState'],
    ['projectFindings', 'reviewState'],
    ['getCreditBalanceCents', 'billing'],
    ['creditPrepaidTopUp', 'billing'],
    ['debitOverageCredits', 'billing'],
    ['overageDebitNetCents', 'billing'],
    ['refundOverageCredits', 'billing'],
    ['reconcileOverageDebit', 'billing'],
    ['clawbackPrepaidCredits', 'billing'],
    ['getTenantPlan', 'billing'],
    ['setTenantPlan', 'billing'],
    ['getTenantBilling', 'billing'],
    ['setTenantBilling', 'billing'],
    ['countAccountReviews', 'billing'],
    ['countRunningAccountReviews', 'billing'],
    ['countRunningCogsReservations', 'billing'],
    ['countTenantReviewUnits', 'billing'],
    ['oldestAccountReviewCreatedAt', 'billing'],
    ['countTenantCompletedReviewsSince', 'billing'],
    ['completedReviewUnitsSince', 'billing'],
    ['reviewRunOverageUnits', 'billing'],
    ['countAccountCommandRuns', 'billing'],
    ['secondsSinceLastCompletedReview', 'billing'],
    ['recordStripeRevenueEvent', 'billing'],
    ['assignUnlinkedStripeRevenue', 'billing'],
    ['sumStripeRefundsForCharge', 'billing'],
    ['enqueueStripeMeterEvent', 'billing'],
    ['getStripeMeterEvent', 'billing'],
    ['listPendingStripeMeterEvents', 'billing'],
    ['markStripeMeterAttempt', 'billing'],
    ['setStripeMeterEventName', 'billing'],
    ['markStripeMeterReported', 'billing'],
    ['listPlatformCosts', 'billing'],
    ['upsertPlatformCost', 'billing'],
    ['deletePlatformCost', 'billing'],
    ['getSuperadminCostAnalytics', 'billing'],
    ['listScorecardRuns', 'billing'],
    ['sumAccountCost', 'billing'],
    ['recordAbuseSignal', 'maintenance'],
    ['countDistinctAccountsFromIp', 'maintenance'],
    ['claimWebhookEvent', 'maintenance'],
    ['getWebhookEvent', 'maintenance'],
    ['completeWebhookEvent', 'maintenance'],
    ['releaseWebhookEvent', 'maintenance'],
    ['claimWebhookBodyHash', 'maintenance'],
    ['webhookBodyProvider', 'maintenance'],
    ['pingDb', 'maintenance'],
    ['failStaleRunningRuns', 'maintenance'],
    ['heartbeatReviewRun', 'maintenance'],
    ['interruptReviewRun', 'maintenance'],
    ['pruneEphemeralData', 'maintenance'],
    ['claimReviewPublication', 'reviewPublications'],
    ['completeReviewPublication', 'reviewPublications'],
    ['releaseReviewPublication', 'reviewPublications'],
    ['listAbandonedReviewPublications', 'reviewPublications'],
    ['resolveAbandonedReviewPublication', 'reviewPublications'],
    ['listReviewPublicationResolutions', 'reviewPublications'],
    ['upsertRepo', 'repositoryWrites'],
    ['listScanTargets', 'repositoryWrites'],
    ['setRepoEnabled', 'repositoryWrites'],
    ['disableRepoByGitHubId', 'repositoryWrites'],
    ['disableReposForInstallation', 'repositoryWrites'],
    ['updateRepoSettings', 'repositoryWrites'],
    ['isRepoEnabled', 'repositoryWrites'],
    ['isRepoActionEnabled', 'repositoryWrites'],
    ['upsertPullRequest', 'repositoryWrites'],
    ['markReviewedNow', 'repositoryWrites'],
    ['updateWorkspaceSettings', 'repositoryWrites'],
    ['close', 'lifecycle'],
  ]);
  assert.deepEqual(
    [
      ...new Set(
        databaseClass.members
          .filter(
            (member): member is ts.MethodDeclaration =>
              ts.isMethodDeclaration(member) &&
              Boolean(member.name) &&
              ts.isIdentifier(member.name),
          )
          .filter(
            (member) =>
              !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword),
          )
          .map((member) => member.name.getText(file))
          .filter((name) => !delegates.has(name)),
      ),
    ].sort(),
    [],
    'new public AppDatabase methods must be explicit repository delegates',
  );
  for (const member of databaseClass.members) {
    if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
    const repository = delegates.get(member.name.text);
    if (!repository) continue;
    const body = member.body?.getText(file) ?? '';
    assert.match(body, new RegExp(`this\\.${repository}\\.`));
    assert.equal(
      body.includes('this.db'),
      false,
      `${member.name.text} must not keep SQL in the facade`,
    );
  }
});
