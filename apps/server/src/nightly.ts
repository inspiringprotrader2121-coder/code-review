import { buildRepoContext, createInstallationOctokit } from '@orvex-review/github';
import type { ReviewQueue } from '@orvex-review/queue';
import {
  dropSelfNegatingFindings,
  llmFindingsToReviewFindings,
  runLlmReview,
  verifyFindings,
  type ReviewFinding,
} from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { loadWorkerConfig, type WorkerConfig } from './pipeline.js';

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

const LOOKBACK_DAYS = Number(process.env.ORVEX_NIGHTLY_LOOKBACK_DAYS ?? 1);
const SCAN_HOUR = Number(process.env.ORVEX_NIGHTLY_HOUR ?? 3); // UTC hour to run

export function startNightlyScheduler(queue: ReviewQueue): () => void {
  if (process.env.ORVEX_NIGHTLY_SCANS !== '1') {
    return () => {};
  }
  let running = true;
  let lastRunDay = '';

  // Check hourly and fire once when the target hour arrives — robust to restarts
  // (an in-memory "already ran today" guard), unlike a naive 24h interval.
  const check = async () => {
    if (!running) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== SCAN_HOUR || lastRunDay === day) return;
    lastRunDay = day;
    await enqueueNightlyScans(queue);
  };

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
  for (const t of targets) {
    await queue.enqueue({
      kind: 'scan',
      action: 'command', // time-based idempotency key; never deduped
      installationId: t.installationId,
      tenantId: t.tenantId,
      owner: t.owner,
      repo: t.name,
      pr: 0,
      headSha: 'nightly',
      enqueuedAt: new Date().toISOString(),
    });
  }
  if (targets.length > 0) console.log(`[nightly] enqueued ${targets.length} scan(s)`);
  return targets.length;
}

/** Review a repo's recent default-branch commits and file findings as an issue. */
export async function processScanJob(
  job: { installationId: number; tenantId: string; owner: string; repo: string },
  config: WorkerConfig,
): Promise<void> {
  const { installationId, tenantId, owner, repo } = job;
  if (!planFeatures(config.store.getTenantPlan(tenantId)).nightlyScans) return; // double-gate

  const octokit = createInstallationOctokit(config.github, installationId);

  const info = await octokit.rest.repos.get({ owner, repo });
  const branch = info.data.default_branch;
  const until = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const [headCommits, baseCommits] = await Promise.all([
    octokit.rest.repos.listCommits({ owner, repo, sha: branch, per_page: 1 }),
    octokit.rest.repos.listCommits({ owner, repo, sha: branch, until, per_page: 1 }),
  ]);
  const headSha = headCommits.data[0]?.sha;
  const baseSha = baseCommits.data[0]?.sha;
  if (!headSha || !baseSha || headSha === baseSha) {
    console.log(`[nightly] ${owner}/${repo}: no new commits in the last ${LOOKBACK_DAYS}d — skipping`);
    return;
  }

  const cmp = await octokit.rest.repos.compareCommits({ owner, repo, base: baseSha, head: headSha });
  const files = (cmp.data.files ?? [])
    .filter((f) => f.patch && f.status !== 'removed')
    .map((f) => ({ filename: f.filename, status: f.status, patch: f.patch as string }));
  if (files.length === 0) {
    console.log(`[nightly] ${owner}/${repo}: no reviewable changes — skipping`);
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
    context,
  });

  let findings = dropSelfNegatingFindings(llmFindingsToReviewFindings(llm.findings)).kept;

  if (findings.length > 0 && process.env.ORVEX_VERIFY !== '0' && context) {
    const verifyFiles = [...context.changedContents, ...context.related, ...context.dependents, ...context.others];
    const verified = await verifyFindings(findings, verifyFiles, {
      apiKey: config.llmApiKey,
      model: config.llmModel,
      baseUrl: config.llmBaseUrl,
    });
    if (verified.status === 'verified') {
      findings = verified.kept;
    } else {
      console.warn(`[nightly] verification ${verified.status}; keeping discovery findings`);
    }
  }

  if (findings.length === 0) {
    console.log(`[nightly] ${owner}/${repo}: scan clean (0 findings)`);
    return;
  }

  await octokit.rest.issues.create({
    owner,
    repo,
    title: `🌙 Orvex nightly scan — ${findings.length} finding${findings.length === 1 ? '' : 's'} on \`${branch}\``,
    body: formatScanIssue(branch, baseSha, headSha, findings, llm.summary),
  });
  console.log(`[nightly] ${owner}/${repo}: filed issue with ${findings.length} findings`);
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
  if (summary) lines.push('', summary);
  lines.push('', '| Severity | File | Finding |', '| --- | --- | --- |');
  for (const f of sorted) {
    const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
    lines.push(`| ${f.severity} | ${loc} | ${f.message.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  lines.push('', '<sub>Automated nightly scan by Orvex Review. Open a PR to get inline, fixable review comments.</sub>');
  return lines.join('\n');
}
