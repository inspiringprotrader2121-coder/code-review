/**
 * Offline eval harness: replay labeled PRs through the review core (no posting)
 * and score precision/recall against the ground-truth cases. Run on the server
 * where the GitHub + LLM keys live:  pnpm --filter @orvex-review/eval eval
 */
import {
  buildRepoContext,
  fetchPrDiff,
} from '@orvex-review/github';
import {
  dropSelfNegatingFindings,
  llmFindingsToReviewFindings,
  runLlmReview,
  verifyFindings,
  type ReviewFinding,
} from '@orvex-review/review';
import { CASES, type EvalCase } from './cases.js';
import { createBenchmarkOctokit } from './bench/github-auth.js';

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
  // Prefer the production 'standard' target (what real reviews run on) so the
  // eval measures the same model+endpoint. MINIMAX_API=anthropic (or an
  // /anthropic base URL) must route via the Anthropic-compatible client —
  // POSTing chat/completions at that base 404s and the whole eval silently
  // scores 0/N (2026-07-23: every call returned "404 page not found").
  const stdKey = process.env.ORVEX_STANDARD_API_KEY;
  const minimax = process.env.MINIMAX_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (stdKey) {
    const baseUrl = process.env.ORVEX_STANDARD_BASE_URL ?? 'https://api.minimax.io/v1';
    const api =
      process.env.ORVEX_STANDARD_API === 'anthropic' || baseUrl.includes('/anthropic')
        ? ('anthropic' as const)
        : undefined;
    return { apiKey: stdKey, baseUrl, model: process.env.ORVEX_STANDARD_MODEL ?? 'MiniMax-M3', api };
  }
  if (minimax) {
    const baseUrl = process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1';
    const api =
      process.env.MINIMAX_API === 'anthropic' || baseUrl.includes('/anthropic')
        ? ('anthropic' as const)
        : undefined;
    return { apiKey: minimax, baseUrl, model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3', api };
  }
  if (!anthropic) throw new Error('ORVEX_STANDARD_API_KEY, MINIMAX_API_KEY or ANTHROPIC_API_KEY required');
  return { apiKey: anthropic, baseUrl: undefined, model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514' };
}

async function reviewPr(c: EvalCase): Promise<ReviewFinding[]> {
  const octokit = await createBenchmarkOctokit(c.owner, c.repo);
  const ref = { owner: c.owner, repo: c.repo, number: c.pr };
  const { data: pr } = await octokit.rest.pulls.get({ owner: c.owner, repo: c.repo, pull_number: c.pr });
  const sha = pr.head.sha;

  const files = await fetchPrDiff(octokit, ref, { maxFileBytes: 120_000, maxFiles: 40, headSha: sha });
  const reviewable = files.filter((f) => f.patch && f.status !== 'removed');
  if (reviewable.length === 0) return [];

  const llm = llmEnv();
  let context;
  try {
    // Match PRODUCTION context limits so the eval isn't starved relative to what
    // the live pipeline actually gives the model (was 6/4/10KB — far below prod).
    context = await buildRepoContext(octokit, c.owner, c.repo, sha, reviewable.map((f) => f.filename), {
      maxSourceFiles: Number(process.env.ORVEX_CTX_SOURCE ?? 200),
      maxRelated: Number(process.env.ORVEX_CTX_RELATED ?? 18),
      maxDependents: Number(process.env.ORVEX_CTX_DEPENDENTS ?? 12),
      maxFileBytes: Number(process.env.ORVEX_CTX_FILE_BYTES ?? 250_000),
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

const SEV_RANK: Record<string, number> = { P1: 3, P2: 2, P3: 1, info: 0 };

function scoreCase(c: EvalCase, findings: ReviewFinding[]): CaseResult {
  const blob = findings.map((f) => `${f.severity} ${f.file} ${f.message}`).join('\n');
  const missing: string[] = [];
  let recallHits = 0;
  for (const re of c.shouldFlag ?? []) {
    if (re.test(blob)) recallHits++;
    else missing.push(re.source);
  }
  // Severity-aware recall: the pattern must match a finding AT the required
  // severity or higher — a P2 bug reported as info is NOT a catch.
  for (const req of c.shouldFlagSevere ?? []) {
    const hit = findings.some(
      (f) => req.pattern.test(`${f.file} ${f.message}`) && (SEV_RANK[f.severity] ?? 0) >= SEV_RANK[req.minSeverity],
    );
    if (hit) recallHits++;
    else missing.push(`${req.pattern.source} @≥${req.minSeverity}`);
  }
  const falsePos: string[] = [];
  for (const re of c.shouldNotFlag ?? []) {
    if (re.test(blob)) falsePos.push(re.source);
  }
  return {
    name: c.name,
    findings,
    recallHits,
    recallTotal: (c.shouldFlag ?? []).length + (c.shouldFlagSevere ?? []).length,
    falsePositives: falsePos.length,
    missing,
    falsePos,
  };
}

async function main() {
  const only = process.argv[2];
  const cases = only ? CASES.filter((c) => c.name.includes(only)) : CASES;
  const results: CaseResult[] = [];

  const groups = new Map<string, EvalCase[]>();
  for (const c of cases) {
    const key = `${c.owner}/${c.repo}#${c.pr}`;
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }

  for (const [key, group] of groups) {
    process.stdout.write(`▶ ${key} (${group.length} case${group.length === 1 ? '' : 's'}) … `);
    try {
      const findings = await reviewPr(group[0]);
      console.log(`${findings.length} findings`);
      for (const c of group) {
        const r = scoreCase(c, findings);
        results.push(r);
        const parts: string[] = [];
        if (r.recallTotal) parts.push(`recall ${r.recallHits}/${r.recallTotal}`);
        if (c.shouldNotFlag?.length) parts.push(`${r.falsePositives === 0 ? 'no' : r.falsePositives} false-pos`);
        console.log(`    ${r.falsePositives === 0 && r.recallHits === r.recallTotal ? '✅' : '⚠️'} ${c.name}: ${parts.join(', ')}`);
        for (const m of r.missing) console.log(`       ✗ missed: /${m}/`);
        for (const fp of r.falsePos) console.log(`       ✗ false positive: /${fp}/`);
      }
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
