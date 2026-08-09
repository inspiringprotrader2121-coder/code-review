import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../../connection.js';
import type { PrKey, PrReviewState, PrSettings, StoredFinding } from '../../types.js';
import type { ReviewStateLookup } from './contracts.js';

export class SqlitePrReviewStateRepository {
  constructor(
    private readonly db: SqliteConnection,
    private readonly lookup: ReviewStateLookup,
  ) {}

  getState(key: PrKey): PrReviewState | null {
    const row = this.db
      .prepare(
        `SELECT tenant_id, last_sha, findings_json, last_review_at, last_summary_comment_id, codex_thread_id, manual_review_json
       FROM pr_reviews WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | {
          tenant_id: string;
          last_sha: string;
          findings_json: string;
          last_review_at: string;
          last_summary_comment_id: number | null;
          codex_thread_id: string | null;
          manual_review_json: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      installationId: key.installationId,
      tenantId: row.tenant_id,
      owner: key.owner,
      repo: key.repo,
      pr: key.pr,
      lastSha: row.last_sha,
      findings: JSON.parse(row.findings_json),
      lastReviewAt: row.last_review_at,
      lastSummaryCommentId: row.last_summary_comment_id ?? undefined,
      codexThreadId: row.codex_thread_id ?? undefined,
      manualReview: row.manual_review_json ? JSON.parse(row.manual_review_json) : undefined,
    };
  }

  saveState(state: PrReviewState): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO pr_reviews
         (installation_id, owner, repo, pr, tenant_id, last_sha, findings_json, last_review_at, last_summary_comment_id, codex_thread_id, manual_review_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET
           tenant_id = excluded.tenant_id, last_sha = excluded.last_sha, findings_json = excluded.findings_json,
           last_review_at = excluded.last_review_at, last_summary_comment_id = excluded.last_summary_comment_id,
           codex_thread_id = excluded.codex_thread_id, manual_review_json = excluded.manual_review_json`,
        )
        .run(
          state.installationId,
          state.owner,
          state.repo,
          state.pr,
          state.tenantId,
          state.lastSha,
          JSON.stringify(state.findings),
          state.lastReviewAt,
          state.lastSummaryCommentId ?? null,
          state.codexThreadId ?? null,
          state.manualReview ? JSON.stringify(state.manualReview) : null,
        );
      this.replaceFindings(
        {
          tenantId: state.tenantId,
          installationId: state.installationId,
          owner: state.owner,
          repo: state.repo,
          pr: state.pr,
        },
        state.findings,
      );
    })();
  }

  getPrSettings(key: PrKey): PrSettings {
    const row = this.db
      .prepare(
        `SELECT auto_apply, updated_at FROM pr_settings WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | { auto_apply: number; updated_at: string }
      | undefined;
    let autoApply = row ? Boolean(row.auto_apply) : undefined;
    if (autoApply === undefined) {
      const repo = this.lookup.getRepoByFullName(key.installationId, `${key.owner}/${key.repo}`);
      if (repo?.autoApply) {
        autoApply = true;
      } else if (repo) {
        const installation = this.lookup.getInstallation(key.installationId);
        autoApply = installation
          ? this.lookup.getWorkspaceSettings(installation.tenantId).autoApplyDefault
          : false;
      } else {
        autoApply = false;
      }
    }
    return { ...key, autoApply, updatedAt: row?.updated_at ?? new Date().toISOString() };
  }

  setPrAutoApply(key: PrKey, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO pr_settings (installation_id, owner, repo, pr, auto_apply, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET auto_apply = excluded.auto_apply, updated_at = excluded.updated_at`,
      )
      .run(
        key.installationId,
        key.owner,
        key.repo,
        key.pr,
        enabled ? 1 : 0,
        new Date().toISOString(),
      );
  }

  acquireFixLock(key: PrKey, holder: string, staleMs = 300_000): boolean {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT holder, acquired_at FROM fix_locks WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ?`,
      )
      .get(key.installationId, key.owner, key.repo, key.pr) as
      | { holder: string; acquired_at: string }
      | undefined;
    if (row && now - new Date(row.acquired_at).getTime() < staleMs) return false;
    this.db
      .prepare(
        `INSERT INTO fix_locks (installation_id, owner, repo, pr, holder, acquired_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id, owner, repo, pr) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at`,
      )
      .run(key.installationId, key.owner, key.repo, key.pr, holder, new Date(now).toISOString());
    return true;
  }

  releaseFixLock(key: PrKey, holder: string): void {
    this.db
      .prepare(
        `DELETE FROM fix_locks WHERE installation_id = ? AND owner = ? AND repo = ? AND pr = ? AND holder = ?`,
      )
      .run(key.installationId, key.owner, key.repo, key.pr, holder);
  }

  addSuppression(input: {
    installationId: number;
    owner: string;
    repo: string;
    fingerprint: string;
    ruleId?: string;
    suppressedBy?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO finding_suppressions (installation_id, owner, repo, fingerprint, rule_id, suppressed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, owner, repo, fingerprint) DO NOTHING`,
      )
      .run(
        input.installationId,
        input.owner,
        input.repo,
        input.fingerprint,
        input.ruleId ?? null,
        input.suppressedBy ?? null,
        new Date().toISOString(),
      );
  }

  getSuppressedFingerprints(installationId: number, owner: string, repo: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT fingerprint FROM finding_suppressions WHERE installation_id = ? AND owner = ? AND repo = ?`,
      )
      .all(installationId, owner, repo) as Array<{ fingerprint: string }>;
    return new Set(rows.map((row) => row.fingerprint));
  }

  projectFindings(
    key: { tenantId: string; installationId: number; owner: string; repo: string; pr: number },
    findings: StoredFinding[],
  ): void {
    this.db.transaction(() => this.replaceFindings(key, findings))();
  }

  private replaceFindings(
    key: { tenantId: string; installationId: number; owner: string; repo: string; pr: number },
    findings: StoredFinding[],
  ): void {
    const fullName = `${key.owner}/${key.repo}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `DELETE FROM findings WHERE installation_id = ? AND repo_full_name = ? AND pr_number = ?`,
      )
      .run(key.installationId, fullName, key.pr);
    const insert = this.db.prepare(
      `INSERT INTO findings (id, tenant_id, installation_id, repo_full_name, pr_number, fingerprint, file, line,
        severity, category, message, status, rule_id, github_comment_id, first_seen_sha, fixed_at_sha, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const finding of findings) {
      insert.run(
        randomUUID(),
        key.tenantId,
        key.installationId,
        fullName,
        key.pr,
        finding.fingerprint,
        finding.file,
        finding.line ?? null,
        finding.severity,
        finding.category,
        finding.message,
        finding.status,
        finding.ruleId,
        finding.githubCommentId ?? null,
        finding.firstSeenSha,
        finding.fixedAtSha ?? null,
        now,
        now,
      );
    }
  }
}
