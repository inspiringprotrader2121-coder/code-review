import type { SqliteConnection } from '../connection.js';
import type {
  FindingRecord,
  FindingStatus,
  PullRequest,
  PullRequestState,
  ReviewRun,
  ReviewRunStatus,
  WorkspaceSettings,
  WorkspaceStats,
} from '../types.js';

/** Tenant-scoped dashboard and workspace read contract. */
export interface WorkspaceReadStore {
  listReviewRuns(tenantId: string, limit?: number): ReviewRun[];
  getWorkspaceStats(tenantId: string, sinceDays?: number): WorkspaceStats;
  listPullRequests(
    tenantId: string,
    opts?: { state?: PullRequestState; limit?: number },
  ): PullRequest[];
  getPullRequestCounts(tenantId: string): { open: number; merged: number; closed: number };
  listFindings(
    tenantId: string,
    opts?: { status?: FindingStatus; repoFullName?: string; limit?: number },
  ): FindingRecord[];
  getFindingCounts(tenantId: string): {
    open: number;
    fixed: number;
    ignored: number;
    bySeverity: Record<string, number>;
  };
  getWorkspaceSettings(tenantId: string): WorkspaceSettings;
}

export class WorkspaceReadRepository implements WorkspaceReadStore {
  constructor(private readonly db: SqliteConnection) {}

  listReviewRuns(tenantId: string, limit = 50): ReviewRun[] {
    const rows = this.db
      .prepare(
        `SELECT review_runs.*, (
           EXISTS (
             SELECT 1 FROM review_run_usage
             WHERE review_run_usage.run_id = review_runs.id
               AND review_run_usage.token_source != 'provider'
           ) OR EXISTS (
             SELECT 1 FROM review_run_attempts AS attempt
             WHERE attempt.run_id = review_runs.id
               AND attempt.outcome IN ('failed', 'timed_out', 'rate_limited', 'cancelled')
               AND NOT EXISTS (
                 SELECT 1 FROM review_run_usage AS usage
                 WHERE usage.attempt_id = attempt.id
               )
           )
         ) AS cost_estimated
         FROM review_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
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
      .get(tenantId, since) as WorkspaceStatsRow;
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

  listPullRequests(
    tenantId: string,
    opts: { state?: PullRequestState; limit?: number } = {},
  ): PullRequest[] {
    const limit = opts.limit ?? 100;
    const rows = opts.state
      ? (this.db
          .prepare(
            `SELECT * FROM pull_requests WHERE tenant_id = ? AND state = ? ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(tenantId, opts.state, limit) as PullRequestRow[])
      : (this.db
          .prepare(
            `SELECT * FROM pull_requests WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(tenantId, limit) as PullRequestRow[]);
    return rows.map(mapPullRequest);
  }

  getPullRequestCounts(tenantId: string): { open: number; merged: number; closed: number } {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM pull_requests WHERE tenant_id = ? GROUP BY state`)
      .all(tenantId) as Array<{ state: string; n: number }>;
    const counts = { open: 0, merged: 0, closed: 0 };
    for (const row of rows)
      if (row.state in counts) counts[row.state as keyof typeof counts] = row.n;
    return counts;
  }

  listFindings(
    tenantId: string,
    opts: { status?: FindingStatus; repoFullName?: string; limit?: number } = {},
  ): FindingRecord[] {
    const clauses = ['tenant_id = ?'];
    const values: unknown[] = [tenantId];
    if (opts.status) {
      clauses.push('status = ?');
      values.push(opts.status);
    }
    if (opts.repoFullName) {
      clauses.push('lower(repo_full_name) = lower(?)');
      values.push(opts.repoFullName);
    }
    values.push(opts.limit ?? 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM findings WHERE ${clauses.join(' AND ')}
         ORDER BY CASE severity WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 WHEN 'P3' THEN 2 ELSE 3 END,
                  updated_at DESC LIMIT ?`,
      )
      .all(...values) as FindingRow[];
    return rows.map(mapFinding);
  }

  getFindingCounts(tenantId: string): {
    open: number;
    fixed: number;
    ignored: number;
    bySeverity: Record<string, number>;
  } {
    const statusRows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM findings WHERE tenant_id = ? GROUP BY status`)
      .all(tenantId) as Array<{ status: string; n: number }>;
    const severityRows = this.db
      .prepare(
        `SELECT severity, COUNT(*) AS n FROM findings WHERE tenant_id = ? AND status = 'open' GROUP BY severity`,
      )
      .all(tenantId) as Array<{ severity: string; n: number }>;
    const counts = { open: 0, fixed: 0, ignored: 0, bySeverity: {} as Record<string, number> };
    for (const row of statusRows) {
      if (row.status === 'open' || row.status === 'fixed' || row.status === 'ignored')
        counts[row.status] = row.n;
    }
    for (const row of severityRows) counts.bySeverity[row.severity] = row.n;
    return counts;
  }

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
}

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
  cost_estimated?: number;
  deep: number;
  free_tier: number;
  new_findings_json: string | null;
  worker_id: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface WorkspaceStatsRow {
  runs_total: number;
  runs_completed: number | null;
  runs_skipped: number | null;
  runs_failed: number | null;
  findings_new: number | null;
  findings_fixed: number | null;
  cost_usd: number | null;
  avg_duration_ms: number | null;
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

interface WorkspaceSettingsRow {
  tenant_id: string;
  default_review_mode: string;
  auto_apply_default: number;
  min_confidence: number;
  max_comments: number;
  auto_enable_new_repos: number;
  updated_at: string;
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
    costEstimated: row.cost_estimated === 1,
    deep: row.deep === 1,
    freeTier: row.free_tier === 1,
    newFindings: row.new_findings_json ? parseNewFindings(row.new_findings_json) : undefined,
    workerId: row.worker_id ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
  };
}

function mapPullRequest(row: PullRequestRow): PullRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    repoFullName: row.repo_full_name,
    number: row.number,
    title: row.title,
    author: row.author,
    state: row.state as PullRequestState,
    draft: Boolean(row.draft),
    headSha: row.head_sha,
    url: row.url ?? undefined,
    openFindings: row.open_findings,
    openedAt: row.opened_at ?? undefined,
    closedAt: row.closed_at ?? undefined,
    mergedAt: row.merged_at ?? undefined,
    lastReviewedAt: row.last_reviewed_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function mapFinding(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    fingerprint: row.fingerprint,
    file: row.file,
    line: row.line ?? undefined,
    severity: row.severity,
    category: row.category,
    message: row.message,
    status: row.status as FindingStatus,
    ruleId: row.rule_id,
    githubCommentId: row.github_comment_id ?? undefined,
    firstSeenSha: row.first_seen_sha,
    fixedAtSha: row.fixed_at_sha ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkspaceSettings(row: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    tenantId: row.tenant_id,
    defaultReviewMode: row.default_review_mode === 'strict' ? 'strict' : 'normal',
    autoApplyDefault: Boolean(row.auto_apply_default),
    minConfidence: row.min_confidence,
    maxComments: row.max_comments,
    autoEnableNewRepos: Boolean(row.auto_enable_new_repos),
    updatedAt: row.updated_at,
  };
}

function parseNewFindings(
  raw: string,
): Array<{ severity: string; file: string; line?: number }> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (item): item is { severity: string; file: string; line?: number } =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as { severity?: unknown }).severity === 'string' &&
        typeof (item as { file?: unknown }).file === 'string' &&
        ((item as { line?: unknown }).line === undefined ||
          Number.isFinite((item as { line?: unknown }).line)),
    );
  } catch {
    return undefined;
  }
}
