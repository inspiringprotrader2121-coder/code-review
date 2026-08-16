import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../../connection.js';
import type { ReviewRun, ReviewRunAttemptOutcome } from '../../types.js';
import type {
  ReviewReservationInput,
  ReviewReservationResult,
  ReviewRunCompletion,
  ReviewRunRecordInput,
  ReviewRunStartInput,
  ReviewStateBillingPort,
} from './contracts.js';
import type { SqliteReviewAttemptRepository } from './provider-attempts.js';

/** Owns review-run transitions. Every terminal mutation remains worker-fenced. */
export class SqliteReviewRunLifecycleRepository {
  constructor(
    private readonly db: SqliteConnection,
    private readonly billing: ReviewStateBillingPort,
    private readonly attempts: SqliteReviewAttemptRepository,
    private readonly workerId: string,
  ) {}

  recordReviewRun(input: ReviewRunRecordInput): ReviewRun {
    const id = randomUUID();
    const now = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO review_runs
       (id, tenant_id, installation_id, owner, repo, pr, head_sha, action, status, skip_reason, error, duration_ms, findings_new, findings_fixed, findings_open, deep, free_tier, worker_id, heartbeat_at, completed_at, created_at)
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

  startReviewRun(input: ReviewRunStartInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO review_runs
       (id, tenant_id, installation_id, owner, repo, pr, head_sha, action, status, skip_reason, error, duration_ms, findings_new, findings_fixed, findings_open, deep, free_tier, worker_id, heartbeat_at, completed_at, created_at)
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

  tryReserveReviewRun(
    input: ReviewReservationInput,
    limitReason: () => string | null,
  ): ReviewReservationResult {
    return this.db
      .transaction(() => {
        const reason = limitReason();
        if (reason) {
          // Tenant concurrency and hourly overflow wait in the queue. Recording
          // a skipped run here made the dashboard look like the review never ran
          // while workers hot-looped thousands of placeholder rows per PR.
          if (reason !== 'concurrency_limited' && reason !== 'rate_limited') {
            this.recordReviewRun({
              ...input,
              status: 'skipped',
              skipReason: reason,
              durationMs: 0,
            });
          }
          return { ok: false as const, reason };
        }
        const rawDebit =
          typeof input.computeOverageDebit === 'function'
            ? input.computeOverageDebit()
            : (input.overageDebitCents ?? 0);
        const debit = Math.max(0, Math.floor(Number(rawDebit) || 0));
        const runId = this.startReviewRun(input);
        if (
          debit > 0 &&
          !this.billing.debitOverageCredits(
            input.tenantId,
            runId,
            debit,
            input.deep ? 'prepaid overage (deep=2 units)' : 'prepaid overage',
          )
        ) {
          this.completeReviewRun(runId, {
            status: 'skipped',
            skipReason: 'insufficient_credits',
            durationMs: 0,
          });
          return { ok: false as const, reason: 'insufficient_credits' };
        }
        return { ok: true as const, runId };
      })
      .immediate();
  }

  setReviewRunHeadSha(id: string, headSha: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE review_runs SET head_sha = ? WHERE id = ? AND status = 'running' AND worker_id = ?`,
        )
        .run(headSha, id, this.workerId).changes > 0
    );
  }

  resumeReviewRun(
    id: string,
    input: Pick<
      ReviewRunStartInput,
      'tenantId' | 'installationId' | 'owner' | 'repo' | 'pr' | 'action'
    >,
  ): 'resumed' | 'completed' | 'unavailable' {
    const row = this.db
      .prepare(
        `SELECT status, skip_reason, tenant_id, installation_id, owner, repo, pr, action FROM review_runs WHERE id = ?`,
      )
      .get(id) as
      | {
          status: ReviewRun['status'];
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
    )
      return 'unavailable';
    if (row.status === 'completed') return 'completed';
    if (row.status !== 'skipped' || !row.skip_reason?.startsWith('interrupted by restart'))
      return 'unavailable';
    return this.db
      .prepare(
        `UPDATE review_runs SET status = 'running', skip_reason = NULL, error = NULL, duration_ms = 0, worker_id = ?, heartbeat_at = ?, completed_at = NULL
       WHERE id = ? AND status = 'skipped' AND skip_reason LIKE 'interrupted by restart%'`,
      )
      .run(this.workerId, new Date().toISOString(), id).changes > 0
      ? 'resumed'
      : 'unavailable';
  }

  completeReviewRun(id: string, patch: ReviewRunCompletion): boolean {
    const totals = this.attempts.usageTotals(id);
    const completedAt = new Date().toISOString();
    const completed = this.db
      .prepare(
        `UPDATE review_runs SET status = ?, skip_reason = ?, error = ?, duration_ms = ?, findings_new = ?, findings_fixed = ?, findings_open = ?,
       input_tokens = ?, output_tokens = ?, cost_usd = ?, new_findings_json = ?, deep = COALESCE(?, deep), completed_at = ?, worker_id = NULL
       WHERE id = ? AND status = 'running' AND worker_id = ?`,
      )
      .run(
        patch.status,
        patch.skipReason ?? null,
        patch.error ?? null,
        patch.durationMs,
        patch.findingsNew ?? 0,
        patch.findingsFixed ?? 0,
        patch.findingsOpen ?? 0,
        patch.inputTokens ?? totals.inputTokens,
        patch.outputTokens ?? totals.outputTokens,
        patch.costUsd ?? totals.costUsd,
        patch.newFindings ? JSON.stringify(patch.newFindings) : null,
        patch.deep === undefined ? null : patch.deep ? 1 : 0,
        completedAt,
        id,
        this.workerId,
      );
    if (completed.changes > 0) {
      const outcome: ReviewRunAttemptOutcome = patch.status === 'skipped' ? 'cancelled' : 'failed';
      this.attempts.closeRunningAttempts(
        id,
        outcome,
        patch.error ?? patch.skipReason ?? 'review ended before attempt completion',
        completedAt,
      );
    }
    return completed.changes > 0;
  }
}
