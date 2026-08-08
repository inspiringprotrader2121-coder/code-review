import { buildRepoContext, createInstallationOctokit, fetchCompareDiff } from '@orvex-review/github';
import type { ReviewQueue } from '@orvex-review/queue';
import {
  dropSelfNegatingFindings,
  fingerprintFinding,
  llmFindingsToReviewFindings,
  runLlmReview,
  sanitizeFileCell,
  sanitizeFindingText,
  verifyFindings,
  type ReviewFinding,
} from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import {
  createUsageRecorder,
  loadWorkerConfig,
  accountLimitReason,
  type LlmTarget,
  type WorkerConfig,
} from './pipeline.js';
import { isVerificationEnabled } from './verify-gate.js';

/**
 * Nightly whole-repo scans — the Verify/Enterprise scheduled-scan feature.
 *
 * Once a day it reviews each eligible repo's recent commits on the default branch
 * (a diff the normal PR path never sees) and files the findings as a GitHub issue.
 * Reuses the review engine end-to-end.
 *
 * OFF by default: only runs when ORVEX_NIGHTLY_SCANS=1, and only for tenants whose
 * plan has `nightlyScans`. Both gates must hold.
 */

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

const LOOKBACK_DAYS = boundedEnvInt('ORVEX_NIGHTLY_LOOKBACK_DAYS', 1, 1, 30);
const SCAN_HOUR = boundedEnvInt('ORVEX_NIGHTLY_HOUR', 3, 0, 23); // UTC hour to run
/** Per-tenant daily ceiling on nightly scan reservations (unbounded repos → cost). */
const MAX_SCANS_PER_TENANT_DAY = boundedEnvInt('ORVEX_NIGHTLY_MAX_SCANS_PER_TENANT', 25, 1, 500);

export function startNightlyScheduler(queue: ReviewQueue): () => void {
  if (process.env.ORVEX_NIGHTLY_SCANS !== '1') {
    return () => {};
  }
  let running = true;
  let lastRunDay = '';
  let checkInProgress = false;

  // Check hourly and fire once when the target hour arrives — robust to restarts
  // (an in-memory "already ran today" guard), unlike a naive 24h interval.
  const check = async () => {
    if (!running) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== SCAN_HOUR || lastRunDay === day || checkInProgress) return;
    checkInProgress = true;
    try {
      await enqueueNightlyScans(queue);
      lastRunDay = day;
    } finally {
      checkInProgress = false;
    }
  };

  void check().catch((err) => console.error('[nightly] scheduler error', err));
  const interval = setInterval(() => {
    check().catch((err) => console.error('[nightly] scheduler error', err));
  }, 3_600_000); // hourly

  console.log(`[nightly] scheduler active — daily scans at ${SCAN_HOUR}:00 UTC`);
  return () => {
    running = false;
    clearInterval(interval);
  };
}

/** Enumerate eligible repos and enqueue a scan job for each. */
export async function enqueueNightlyScans(queue: ReviewQueue): Promise<number> {
  const config = loadWorkerConfig();
  const targets = config.store.listScanTargets().filter((t) => planFeatures(t.plan).nightlyScans);
  const scanDay = new Date().toISOString().slice(0, 10);
  const perTenant = new Map<string, number>();
  let enqueued = 0;
  for (const t of targets) {
    const n = perTenant.get(t.tenantId) ?? 0;
    if (n >= MAX_SCANS_PER_TENANT_DAY) {
      console.warn(
        `[nightly] tenant ${t.tenantId} hit daily scan cap (${MAX_SCANS_PER_TENANT_DAY}) — skipping ${t.owner}/${t.name}`,
      );
      continue;
    }
    perTenant.set(t.tenantId, n + 1);
    await queue.enqueue({
      kind: 'scan',
      action: 'command', // scanDay makes one enqueue idempotent per repo/day
      installationId: t.installationId,
      tenantId: t.tenantId,
      owner: t.owner,
      repo: t.name,
      pr: 0,
      headSha: 'nightly',
      scanDay,
      enqueuedAt: new Date().toISOString(),
    });
    enqueued++;
  }
  if (enqueued > 0) console.log(`[nightly] enqueued ${enqueued} scan(s)`);
  return enqueued;
}

/** Review a repo's recent default-branch commits and file findings as an issue. */
export async function processScanJob(
  job: { installationId: number; tenantId: string; owner: string; repo: string; scanDay?: string },
  config: WorkerConfig,
): Promise<void> {
  const { installationId, tenantId, owner, repo } = job;
  const plan = planFeatures(config.store.getTenantPlan(tenantId));
  if (!plan.nightlyScans) return; // double-gate
  const startedAt = Date.now();
  const scanTarget: LlmTarget = {
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    api: config.llmApi,
  };
  const reserved = config.store.tryReserveReviewRun({
    tenantId,
    installationId,
    owner,
    repo,
    pr: 0,
    headSha: `nightly:${job.scanDay ?? new Date().toISOString().slice(0, 10)}`,
    action: 'scan:nightly',
  }, () =>
    // Scans must not consume PR included/prepaid quota, but they MUST reserve
    // COGS headroom (and pass tenantId for any future prepaid hooks).
    accountLimitReason(config.store, owner, plan, 1, 0, { tenantId, cogsOnly: true }),
  );
  if (!reserved.ok) {
    console.warn(`[nightly] ${owner}/${repo}: ${reserved.reason} — skipping`);
    return;
  }
  const runId = reserved.runId;
  let status: 'completed' | 'skipped' | 'failed' = 'completed';
  let error: string | undefined;

  try {
    const octokit = createInstallationOctokit(config.github, installationId);

  const info = await octokit.rest.repos.get({ owner, repo });
  const branch = info.data.default_branch;
  const until = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const [headCommits, baseCommits] = await Promise.all([
    octokit.rest.repos.listCommits({ owner, repo, sha: branch, per_page: 1 }),
    octokit.rest.repos.listCommits({ owner, repo, sha: branch, until, per_page: 1 }),
  ]);
  const headSha = headCommits.data[0]?.sha;
  let baseSha = baseCommits.data[0]?.sha;
  // New repos often have no commits older than the lookback window, so `until`
  // returns empty. Fall back to the oldest commit we can page so the first
  // nightly still has a compare base.
  if (headSha && !baseSha) {
    const recent = await octokit.rest.repos.listCommits({ owner, repo, sha: branch, per_page: 100 });
    baseSha = recent.data[recent.data.length - 1]?.sha;
  }
  if (!headSha || !baseSha || headSha === baseSha) {
    console.log(`[nightly] ${owner}/${repo}: no new commits in the last ${LOOKBACK_DAYS}d — skipping`);
    status = 'skipped';
    return;
  }

  const compared = await fetchCompareDiff(octokit, owner, repo, baseSha, headSha, {
    maxFileBytes: 100_000,
    maxFiles: 1_000,
  });
  const files = compared.files
    .filter((f) => f.patch && f.status !== 'removed')
    .map((f) => ({ filename: f.filename, status: f.status, patch: f.patch as string }));
  if (files.length === 0) {
    console.log(`[nightly] ${owner}/${repo}: no reviewable changes — skipping`);
    status = 'skipped';
    return;
  }

  let context: Awaited<ReturnType<typeof buildRepoContext>> | undefined;
  try {
    context = await buildRepoContext(octokit, owner, repo, headSha, files.map((f) => f.filename), {
      maxSourceFiles: 60,
      maxRelated: 25,
      maxDependents: 15,
      maxFileBytes: 24_000,
      maxOthers: 40,
    });
  } catch {
    /* diff-only fallback */
  }

  const llm = await runLlmReview(files, {
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    api: scanTarget.api,
    reasoningEffort: scanTarget.reasoningEffort,
    context,
    onUsage: createUsageRecorder(config, runId, tenantId, 'premium', scanTarget, 'nightly discovery'),
  });

  let findings = dropSelfNegatingFindings(llmFindingsToReviewFindings(llm.findings)).kept;

  if (findings.length > 0 && isVerificationEnabled() && context) {
    const verifyFiles = [...context.changedContents, ...context.related, ...context.dependents, ...context.others];
    const verified = await verifyFindings(findings, verifyFiles, {
      apiKey: config.llmApiKey,
      model: config.llmModel,
      baseUrl: config.llmBaseUrl,
      api: scanTarget.api,
      reasoningEffort: scanTarget.reasoningEffort,
      onUsage: createUsageRecorder(config, runId, tenantId, 'premium', scanTarget, 'nightly verification'),
    });
    if (verified.status === 'verified') {
      // Keep unverified candidates too (same union as PR partitionVerifiedFindings
      // for missing verdicts) — dropping them discarded real P1/P2s when the
      // verifier omitted a verdict.
      const seen = new Set(verified.kept.map((f) => fingerprintFinding(f)));
      findings = [
        ...verified.kept,
        ...verified.unverified.filter((f) => {
          const fp = fingerprintFinding(f);
          if (seen.has(fp)) return false;
          seen.add(fp);
          return true;
        }),
      ];
    } else {
      console.warn(`[nightly] verification ${verified.status}; keeping discovery findings`);
    }
  }

  if (findings.length === 0) {
    console.log(`[nightly] ${owner}/${repo}: scan clean (0 findings)`);
    status = 'completed';
    return;
  }

  await octokit.rest.issues.create({
    owner,
    repo,
    title: `🌙 Orvex nightly scan — ${findings.length} finding${findings.length === 1 ? '' : 's'} on \`${branch}\``,
    body: formatScanIssue(branch, baseSha, headSha, findings, llm.summary),
  });
  console.log(`[nightly] ${owner}/${repo}: filed issue with ${findings.length} findings`);
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    config.store.completeReviewRun(runId, {
      status,
      error,
      skipReason: status === 'skipped' ? error : undefined,
      durationMs: Date.now() - startedAt,
    });
  }
}

function formatScanIssue(
  branch: string,
  baseSha: string,
  headSha: string,
  findings: ReviewFinding[],
  summary?: string,
): string {
  const rank: Record<string, number> = { P1: 0, P2: 1, P3: 2, info: 3 };
  const sorted = [...findings].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  const lines = [
    `Orvex scanned the last ${LOOKBACK_DAYS} day(s) of commits on \`${branch}\` (\`${baseSha.slice(0, 7)}\`…\`${headSha.slice(0, 7)}\`).`,
  ];
  if (summary) lines.push('', sanitizeFindingText(summary));
  lines.push('', '| Severity | File | Finding |', '| --- | --- | --- |');
  for (const f of sorted) {
    const safeFile = sanitizeFileCell(f.file);
    const loc = f.line ? `\`${safeFile}:${f.line}\`` : `\`${safeFile}\``;
    const message = sanitizeFindingText(f.message).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${f.severity} | ${loc} | ${message} |`);
  }
  lines.push('', '<sub>Automated nightly scan by Orvex Review. Open a PR to get inline, fixable review comments.</sub>');
  return lines.join('\n');
}
