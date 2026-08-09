import { createHash, randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../connection.js';

export interface ReviewPublicationScope {
  tenantId: string;
  runId: string;
  artifactKey: string;
}

export type ReviewPublicationClaim =
  | { status: 'claimed'; claimToken: string }
  | { status: 'published'; resultJson: string | null }
  | { status: 'in_progress' }
  | { status: 'not_owner' };

export interface AbandonedReviewPublication {
  tenantId: string;
  runId: string;
  artifactKey: string;
  claimedBy: string;
  claimedAt: string;
  runStatus: string;
  runWorkerId?: string;
  runHeartbeatAt?: string;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
}

export interface ReviewPublicationResolution {
  id: string;
  tenantId: string;
  runId: string;
  artifactKey: string;
  action: 'retry' | 'mark_published';
  actor: string;
  reason: string;
  resolvedAt: string;
}

export interface ResolveReviewPublicationInput extends ReviewPublicationScope {
  action: ReviewPublicationResolution['action'];
  actor: string;
  reason: string;
  abandonedBefore: string;
  resultJson?: string | null;
}

/**
 * Durable fence around a single GitHub side effect. `published` rows are
 * immutable; a known failed write releases its token so the owning worker can
 * retry. A claim that outlives its worker is deliberately not auto-reclaimed:
 * GitHub does not provide an idempotency key, so its external outcome is
 * unknowable after a crash.
 */
export class SqliteReviewPublicationRepository {
  constructor(
    private readonly db: SqliteConnection,
    private readonly workerId: string,
  ) {}

  claimReviewPublication(scope: ReviewPublicationScope): ReviewPublicationClaim {
    this.validateScope(scope);
    return this.db
      .transaction(() => {
        const claimedAt = new Date().toISOString();
        const claimToken = randomUUID();
        const inserted = this.db
          .prepare(
            `INSERT INTO review_publications
           (tenant_id, run_id, artifact_key, state, claim_token, claimed_by, claimed_at)
           SELECT ?, ?, ?, 'publishing', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM review_runs
             WHERE id = ? AND tenant_id = ? AND status = 'running' AND worker_id = ?
           )
           ON CONFLICT(tenant_id, run_id, artifact_key) DO NOTHING`,
          )
          .run(
            scope.tenantId,
            scope.runId,
            scope.artifactKey,
            claimToken,
            this.workerId,
            claimedAt,
            scope.runId,
            scope.tenantId,
            this.workerId,
          );
        if (inserted.changes > 0) return { status: 'claimed' as const, claimToken };

        const existing = this.db
          .prepare(
            `SELECT state, result_json FROM review_publications
           WHERE tenant_id = ? AND run_id = ? AND artifact_key = ?`,
          )
          .get(scope.tenantId, scope.runId, scope.artifactKey) as
          | { state: 'publishing' | 'published'; result_json: string | null }
          | undefined;
        if (existing?.state === 'published') {
          return { status: 'published' as const, resultJson: existing.result_json };
        }
        if (existing) return { status: 'in_progress' as const };
        return { status: 'not_owner' as const };
      })
      .immediate();
  }

  completeReviewPublication(
    scope: ReviewPublicationScope & { claimToken: string; resultJson: string | null },
  ): boolean {
    this.validateScope(scope);
    return (
      this.db
        .prepare(
          `UPDATE review_publications
         SET state = 'published', result_json = ?, published_at = ?
         WHERE tenant_id = ? AND run_id = ? AND artifact_key = ?
           AND state = 'publishing' AND claim_token = ?
           AND EXISTS (
             SELECT 1 FROM review_runs
             WHERE id = ? AND tenant_id = ? AND status = 'running' AND worker_id = ?
           )`,
        )
        .run(
          scope.resultJson,
          new Date().toISOString(),
          scope.tenantId,
          scope.runId,
          scope.artifactKey,
          scope.claimToken,
          scope.runId,
          scope.tenantId,
          this.workerId,
        ).changes > 0
    );
  }

  releaseReviewPublication(scope: ReviewPublicationScope & { claimToken: string }): boolean {
    this.validateScope(scope);
    return (
      this.db
        .prepare(
          `DELETE FROM review_publications
         WHERE tenant_id = ? AND run_id = ? AND artifact_key = ?
           AND state = 'publishing' AND claim_token = ?
           AND EXISTS (
             SELECT 1 FROM review_runs
             WHERE id = ? AND tenant_id = ? AND status = 'running' AND worker_id = ?
           )`,
        )
        .run(
          scope.tenantId,
          scope.runId,
          scope.artifactKey,
          scope.claimToken,
          scope.runId,
          scope.tenantId,
          this.workerId,
        ).changes > 0
    );
  }

  listAbandonedReviewPublications(
    abandonedBefore: string,
    limit = 100,
  ): AbandonedReviewPublication[] {
    if (!Number.isFinite(Date.parse(abandonedBefore)))
      throw new Error('invalid abandoned publication cutoff');
    const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT p.tenant_id, p.run_id, p.artifact_key, p.claimed_by, p.claimed_at,
                r.status AS run_status, r.worker_id AS run_worker_id,
                r.heartbeat_at AS run_heartbeat_at, r.owner, r.repo, r.pr, r.head_sha
         FROM review_publications p
         JOIN review_runs r ON r.id = p.run_id AND r.tenant_id = p.tenant_id
         WHERE p.state = 'publishing'
           AND (r.status <> 'running' OR r.worker_id IS NULL OR r.worker_id <> p.claimed_by
                OR r.heartbeat_at IS NULL OR r.heartbeat_at < ?)
         ORDER BY p.claimed_at ASC
         LIMIT ?`,
      )
      .all(abandonedBefore, boundedLimit) as Array<{
      tenant_id: string;
      run_id: string;
      artifact_key: string;
      claimed_by: string;
      claimed_at: string;
      run_status: string;
      run_worker_id: string | null;
      run_heartbeat_at: string | null;
      owner: string;
      repo: string;
      pr: number;
      head_sha: string;
    }>;
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      runId: row.run_id,
      artifactKey: row.artifact_key,
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      runStatus: row.run_status,
      runWorkerId: row.run_worker_id ?? undefined,
      runHeartbeatAt: row.run_heartbeat_at ?? undefined,
      owner: row.owner,
      repo: row.repo,
      pr: row.pr,
      headSha: row.head_sha,
    }));
  }

  resolveAbandonedReviewPublication(input: ResolveReviewPublicationInput): boolean {
    this.validateScope(input);
    if (!Number.isFinite(Date.parse(input.abandonedBefore)))
      throw new Error('invalid abandoned publication cutoff');
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    if (!actor || actor.length > 200 || !reason || reason.length > 500) {
      throw new Error('invalid publication resolution audit fields');
    }
    if (input.action === 'mark_published') {
      if (input.resultJson === undefined)
        throw new Error('mark_published requires an explicit result');
      if (input.resultJson !== null) {
        if (Buffer.byteLength(input.resultJson, 'utf8') > 16_384) {
          throw new Error('publication resolution result is too large');
        }
        JSON.parse(input.resultJson);
      }
    }

    return this.db
      .transaction(() => {
        const claim = this.db
          .prepare(
            `SELECT p.claim_token, p.claimed_by, p.claimed_at
           FROM review_publications p
           JOIN review_runs r ON r.id = p.run_id AND r.tenant_id = p.tenant_id
           WHERE p.tenant_id = ? AND p.run_id = ? AND p.artifact_key = ?
             AND p.state = 'publishing'
             AND (r.status <> 'running' OR r.worker_id IS NULL OR r.worker_id <> p.claimed_by
                  OR r.heartbeat_at IS NULL OR r.heartbeat_at < ?)`,
          )
          .get(input.tenantId, input.runId, input.artifactKey, input.abandonedBefore) as
          | { claim_token: string; claimed_by: string; claimed_at: string }
          | undefined;
        if (!claim) return false;

        const resolvedAt = new Date().toISOString();
        const resolutionId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO review_publication_resolutions
           (id, tenant_id, run_id, artifact_key, action, actor, reason,
            claim_token_digest, claimed_by, claimed_at, result_json, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            resolutionId,
            input.tenantId,
            input.runId,
            input.artifactKey,
            input.action,
            actor,
            reason,
            createHash('sha256').update(claim.claim_token).digest('hex'),
            claim.claimed_by,
            claim.claimed_at,
            input.action === 'mark_published' ? (input.resultJson ?? null) : null,
            resolvedAt,
          );

        const changed =
          input.action === 'retry'
            ? this.db
                .prepare(
                  `DELETE FROM review_publications
               WHERE tenant_id = ? AND run_id = ? AND artifact_key = ?
                 AND state = 'publishing' AND claim_token = ?`,
                )
                .run(input.tenantId, input.runId, input.artifactKey, claim.claim_token).changes
            : this.db
                .prepare(
                  `UPDATE review_publications
               SET state = 'published', result_json = ?, published_at = ?
               WHERE tenant_id = ? AND run_id = ? AND artifact_key = ?
                 AND state = 'publishing' AND claim_token = ?`,
                )
                .run(
                  input.resultJson ?? null,
                  resolvedAt,
                  input.tenantId,
                  input.runId,
                  input.artifactKey,
                  claim.claim_token,
                ).changes;
        if (changed !== 1) throw new Error('publication claim changed during operator resolution');
        return true;
      })
      .immediate();
  }

  listReviewPublicationResolutions(limit = 100): ReviewPublicationResolution[] {
    const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, run_id, artifact_key, action, actor, reason, resolved_at
         FROM review_publication_resolutions ORDER BY resolved_at DESC, id DESC LIMIT ?`,
      )
      .all(boundedLimit) as Array<{
      id: string;
      tenant_id: string;
      run_id: string;
      artifact_key: string;
      action: ReviewPublicationResolution['action'];
      actor: string;
      reason: string;
      resolved_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      runId: row.run_id,
      artifactKey: row.artifact_key,
      action: row.action,
      actor: row.actor,
      reason: row.reason,
      resolvedAt: row.resolved_at,
    }));
  }

  private validateScope(scope: ReviewPublicationScope): void {
    if (!scope.tenantId || !scope.runId || !scope.artifactKey || scope.artifactKey.length > 512) {
      throw new Error('invalid review publication scope');
    }
  }
}

export type ReviewPublicationRepository = Pick<
  SqliteReviewPublicationRepository,
  'claimReviewPublication' | 'completeReviewPublication' | 'releaseReviewPublication'
>;

export type ReviewPublicationOperatorRepository = Pick<
  SqliteReviewPublicationRepository,
  | 'listAbandonedReviewPublications'
  | 'resolveAbandonedReviewPublication'
  | 'listReviewPublicationResolutions'
>;
