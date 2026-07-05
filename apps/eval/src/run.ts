/**
 * Offline eval harness: replay labeled PRs through the review core (no posting)
 * and score precision/recall against the ground-truth cases. Run on the server
 * where the GitHub + LLM keys live:  pnpm --filter @orvex-review/eval eval
 */
import {
  buildRepoContext,
  createInstallationOctokit,
  fetchPrDiff,
  getInstallationIdForRepo,
  loadGitHubConfigFromEnv,
} from '@orvex-review/github';
import {
  dropSelfNegatingFindings,
  llmFindingsToReviewFindings,
  runLlmReview,
  verifyFindings,
  type ReviewFinding,
} from '@orvex-review/review';
import { CASES, type EvalCase } from './cases.js';

interface CaseResult {
  name: string;
  findings: ReviewFinding[];
  recallHits: number;
  recallTotal: number;
  falsePositives: number;
  missing: string[];
  falsePos: string[];
}

function llmEnv() {
  const minimax = process.env.MINIMAX_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (minimax) {
    return {
      apiKey: minimax,
      baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1',
      model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3',
    };
  }
  if (!anthropic) throw new Error('MINIMAX_API_KEY or ANTHROPIC_API_KEY required');
  return { apiKey: anthropic, baseUrl: undefined, model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514' };
}

async function reviewPr(c: EvalCase): Promise<ReviewFinding[]> {
  const cfg = loadGitHubConfigFromEnv();
  const installationId = await getInstallationIdForRepo(cfg, c.owner, c.repo);
  const octokit = createInstallationOctokit(cfg, installationId);
  const ref = { owner: c.owner, repo: c.repo, number: c.pr };
  const { data: pr } = await octokit.rest.pulls.get({ owner: c.owner, repo: c.repo, pull_number: c.pr });
  const sha = pr.head.sha;

  const files = await fetchPrDiff(octokit, ref, { maxFileBytes: 120_000, maxFiles: 40, headSha: sha });
  const reviewable = files.filter((f) => f.patch && f.status !== 'removed');
  if (reviewable.length === 0) return [];

  const llm = llmEnv();
  let context;
  try {
    context = await buildRepoContext(octokit, c.owner, c.repo, sha, reviewable.map((f) => f.filename), {
      maxRelated: 6,
      maxDependents: 4,
      maxFileBytes: 10_000,
    });
  } catch {
    /* diff-only fallback */
  }

  const resp = await runLlmReview(
    reviewable.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
    { ...llm, context: { ...(context ?? {}), prTitle: pr.title, prBody: pr.body ?? undefined } },
  );
  let findings = llmFindingsToReviewFindings(resp.findings);

  findings = dropSelfNegatingFindings(findings).kept;

  const ctxFiles = context
    ? [...context.changedContents, ...context.related, ...context.dependents]
    : [];
  if (ctxFiles.length > 0) {
    findings = (await verifyFindings(findings, ctxFiles, { ...llm, prIntent: [pr.title, pr.body].filter(Boolean).join('\n\n') })).kept;
  }
  return findings;
}

function scoreCase(c: EvalCase, findings: ReviewFinding[]): CaseResult {
  const blob = findings.map((f) => `${f.severity} ${f.file} ${f.message}`).join('\n');
  const missing: string[] = [];
  let recallHits = 0;
  for (const re of c.shouldFlag ?? []) {
    if (re.test(blob)) recallHits++;
    else missing.push(re.source);
  }
  const falsePos: string[] = [];
  for (const re of c.shouldNotFlag ?? []) {
    if (re.test(blob)) falsePos.push(re.source);
  }
  return {
    name: c.name,
    findings,
    recallHits,
    recallTotal: (c.shouldFlag ?? []).length,
    falsePositives: falsePos.length,
    missing,
    falsePos,
  };
}

async function main() {
  const only = process.argv[2];
  const cases = only ? CASES.filter((c) => c.name.includes(only)) : CASES;
  const results: CaseResult[] = [];

  for (const c of cases) {
    process.stdout.write(`▶ ${c.name} (${c.owner}/${c.repo}#${c.pr}) … `);
    try {
      const findings = await reviewPr(c);
      const r = scoreCase(c, findings);
      results.push(r);
      const parts: string[] = [];
      if (r.recallTotal) parts.push(`recall ${r.recallHits}/${r.recallTotal}`);
      if (c.shouldNotFlag?.length) parts.push(`${r.falsePositives === 0 ? 'no' : r.falsePositives} false-pos`);
      console.log(`${r.falsePositives === 0 && r.recallHits === r.recallTotal ? '✅' : '⚠️'} ${parts.join(', ')} (${findings.length} findings)`);
      for (const m of r.missing) console.log(`    ✗ missed: /${m}/`);
      for (const fp of r.falsePos) console.log(`    ✗ false positive: /${fp}/`);
    } catch (err) {
      console.log(`ERROR ${(err as Error).message}`);
    }
  }

  const recallHits = results.reduce((a, r) => a + r.recallHits, 0);
  const recallTotal = results.reduce((a, r) => a + r.recallTotal, 0);
  const fp = results.reduce((a, r) => a + r.falsePositives, 0);
  const fpChecks = results.reduce((a, r) => a + ((CASES.find((c) => c.name === r.name)?.shouldNotFlag?.length) ?? 0), 0);
  console.log('\n── summary ──');
  console.log(`recall:    ${recallHits}/${recallTotal} real bugs caught`);
  console.log(`precision: ${fpChecks - fp}/${fpChecks} noise checks passed (${fp} false positives)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
