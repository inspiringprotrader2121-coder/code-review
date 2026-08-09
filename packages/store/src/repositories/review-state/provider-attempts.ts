import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../../connection.js';
import type {
  ReviewRunAttempt,
  ReviewRunAttemptOutcome,
  ReviewRunStatus,
  ReviewRunUsage,
} from '../../types.js';

type RunOwnership = { tenant_id: string; status: ReviewRunStatus; worker_id: string | null };

/** Provider attempt and usage rows are always scoped by the live run owner. */
export class SqliteReviewAttemptRepository {
  constructor(
    private readonly db: SqliteConnection,
    private readonly workerId: string,
  ) {}

  startReviewRunAttempt(
    input: Omit<ReviewRunAttempt, 'outcome' | 'durationMs' | 'completedAt'>,
  ): boolean {
    const run = this.db
      .prepare(`SELECT tenant_id, status, worker_id FROM review_runs WHERE id = ?`)
      .get(input.runId) as RunOwnership | undefined;
    if (!run || run.tenant_id !== input.tenantId)
      throw new Error(`review attempt parent mismatch for run ${input.runId}`);
    if (input.parentAttemptId) {
      const parent = this.db
        .prepare(`SELECT run_id FROM review_run_attempts WHERE id = ?`)
        .get(input.parentAttemptId) as { run_id: string } | undefined;
      if (!parent || parent.run_id !== input.runId)
        throw new Error(`review attempt lineage mismatch for ${input.id}`);
    }
    if (run.status !== 'running' || run.worker_id !== this.workerId) return false;
    return (
      this.db
        .prepare(
          `INSERT INTO review_run_attempts
       (id, run_id, tenant_id, parent_attempt_id, provider, model, tier, pass_name, transport, retry_index, key_index, outcome, error, duration_ms, started_at, completed_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, 0, ?, NULL
       WHERE EXISTS (SELECT 1 FROM review_runs WHERE id = ? AND tenant_id = ? AND status = 'running' AND worker_id = ?)`,
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
          input.runId,
          input.tenantId,
          this.workerId,
        ).changes > 0
    );
  }

  completeReviewRunAttempt(input: {
    id: string;
    outcome: Exclude<ReviewRunAttemptOutcome, 'running'>;
    durationMs: number;
    completedAt: string;
    error?: string;
  }): boolean {
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0)
      throw new Error('invalid review attempt duration');
    return (
      this.db
        .prepare(
          `UPDATE review_run_attempts SET outcome = ?, error = ?, duration_ms = ?, completed_at = ?
       WHERE id = ? AND outcome = 'running' AND EXISTS (
         SELECT 1 FROM review_runs WHERE review_runs.id = review_run_attempts.run_id
         AND review_runs.status = 'running' AND review_runs.worker_id = ?
       )`,
        )
        .run(
          input.outcome,
          input.error ?? null,
          Math.floor(input.durationMs),
          input.completedAt,
          input.id,
          this.workerId,
        ).changes > 0
    );
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

  recordReviewRunUsage(
    input: Omit<ReviewRunUsage, 'id' | 'createdAt'> & { createdAt?: string },
  ): ReviewRunUsage | null {
    const run = this.db
      .prepare(`SELECT tenant_id, status, worker_id FROM review_runs WHERE id = ?`)
      .get(input.runId) as RunOwnership | undefined;
    if (!run) throw new Error(`cannot record usage for unknown review run ${input.runId}`);
    if (run.tenant_id !== input.tenantId)
      throw new Error(`review usage tenant mismatch for run ${input.runId}`);
    if (input.attemptId) {
      const attempt = this.db
        .prepare(`SELECT run_id, tenant_id FROM review_run_attempts WHERE id = ?`)
        .get(input.attemptId) as { run_id: string; tenant_id: string } | undefined;
      if (!attempt || attempt.run_id !== input.runId || attempt.tenant_id !== input.tenantId) {
        throw new Error(`review usage attempt lineage mismatch for ${input.attemptId}`);
      }
    }
    if (run.status !== 'running' || run.worker_id !== this.workerId) return null;
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
    const recorded = this.db
      .prepare(
        `INSERT INTO review_run_usage
       (id, run_id, tenant_id, provider, model, tier, pass_name, input_tokens, output_tokens, input_rate_per_m, output_rate_per_m, cost_usd, token_source, attempt_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM review_runs WHERE id = ? AND tenant_id = ? AND status = 'running' AND worker_id = ?)`,
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
        input.runId,
        input.tenantId,
        this.workerId,
      );
    return recorded.changes > 0 ? { ...input, id, createdAt } : null;
  }

  listReviewRunUsage(runId: string): ReviewRunUsage[] {
    const rows = this.db
      .prepare(`SELECT * FROM review_run_usage WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      tenantId: String(row.tenant_id),
      provider: String(row.provider),
      model: String(row.model),
      tier: String(row.tier),
      passName: row.pass_name ? String(row.pass_name) : undefined,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      inputRatePerM: Number(row.input_rate_per_m),
      outputRatePerM: Number(row.output_rate_per_m),
      costUsd: Number(row.cost_usd),
      tokenSource: row.token_source as ReviewRunUsage['tokenSource'],
      attemptId: row.attempt_id ? String(row.attempt_id) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  usageTotals(runId: string): { inputTokens: number; outputTokens: number; costUsd: number } {
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM review_run_usage WHERE run_id = ?`,
      )
      .get(runId) as { input_tokens: number; output_tokens: number; cost_usd: number };
    return {
      inputTokens: totals.input_tokens,
      outputTokens: totals.output_tokens,
      costUsd: totals.cost_usd,
    };
  }

  closeRunningAttempts(
    runId: string,
    outcome: Exclude<ReviewRunAttemptOutcome, 'running'>,
    error: string,
    completedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE review_run_attempts SET outcome = ?, error = COALESCE(error, ?), completed_at = ?,
       duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
       WHERE run_id = ? AND outcome = 'running'`,
      )
      .run(outcome, error, completedAt, completedAt, runId);
  }
}
