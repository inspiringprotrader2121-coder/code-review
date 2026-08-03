/**
 * Step-1 diagnostic for the greptile gap (ROADMAP Phase 7).
 *
 * For a PR + the file:line where a competitor caught a bug Orvex missed, re-review
 * OFFLINE and print the finding funnel:
 *     raw model findings  →  after noise filter  →  after RECALL verify  →  after STRICT verify
 * and flag, at each stage, whether a finding lands near the known miss location.
 *
 * That tells us WHICH lever to pull:
 *   - raised, then a filter/verifier DROPPED it → recall-tuning fix (cheap).
 *   - never raised at all → rules/prompt + context depth.
 *
 * Uses the standard model (MiniMax) as a proxy — if even it raises the bug, the
 * multi-model ensemble certainly would, so a drop is conclusively a filter problem.
 *
 *   ORVEX_INSTALL_ID=144378482 tsx src/bench/diagnose.ts
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
import { createBenchmarkOctokit } from './github-auth.js';

const OWNER = process.env.BENCH_OWNER ?? 'inspiringprotrader2121-coder';
const REPO = process.env.BENCH_REPO ?? 'Velatrix-Cloud';

interface Target {
  pr: number;
  file: string;
  lines: number[];
  what: string;
}

// PR + the file and lines where a competitor caught a bug Orvex missed.
const DEFAULT_TARGETS: Target[] = [
  { pr: 118, file: 'payment.js', lines: [68, 1105, 1126, 1231], what: 'Stripe coupon/reservation leak on failed checkout' },
  { pr: 121, file: 'xtreamPlayerApi.js', lines: [166, 824, 1073], what: 'failures not recorded under the tenant guard' },
];

function loadTargets(): Target[] {
  const raw = process.env.BENCH_TARGETS;
  if (!raw) return DEFAULT_TARGETS;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('BENCH_TARGETS must be a non-empty JSON array');
  }
  return parsed.map((value, index) => {
    const target = value as Partial<Target>;
    if (!Number.isInteger(target.pr) || typeof target.file !== 'string' || !target.file
      || !Array.isArray(target.lines) || !target.lines.every(Number.isInteger)
      || typeof target.what !== 'string') {
      throw new Error(`BENCH_TARGETS[${index}] is invalid`);
    }
    return target as Target;
  });
}

const TARGETS = loadTargets();
// Match window for "is this finding the known miss?" — aligned with the ±5
// cluster window the bench tools use (was 12: loose enough to count a DIFFERENT
// nearby defect as the target, mislabeling a real miss as "raised").
const NEAR = 5;

function llmEnv() {
  const minimax = process.env.MINIMAX_API_KEY;
  if (minimax) return { apiKey: minimax, baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1', model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3' };
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (!anthropic) throw new Error('MINIMAX_API_KEY or ANTHROPIC_API_KEY required');
  return { apiKey: anthropic, baseUrl: undefined, model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514' };
}

const nearTarget = (f: ReviewFinding, t: Target) =>
  (f.file.endsWith(t.file) || f.file.includes(t.file)) &&
  (f.line == null || t.lines.some((l) => Math.abs((f.line ?? -999) - l) <= NEAR));

function show(stage: string, findings: ReviewFinding[], t: Target) {
  const hits = findings.filter((f) => nearTarget(f, t));
  console.log(`  ${stage.padEnd(22)} ${findings.length} findings${hits.length ? `  ⟵ ${hits.length} NEAR TARGET` : ''}`);
  for (const h of hits) console.log(`        ✦ ${h.severity} ${h.file}:${h.line} — ${h.message.replace(/\s+/g, ' ').slice(0, 100)}`);
}

async function main() {
  const octokit = await createBenchmarkOctokit(OWNER, REPO);
  const llm = llmEnv();

  const targetsByPr = new Map<number, Target[]>();
  for (const target of TARGETS) {
    const targets = targetsByPr.get(target.pr) ?? [];
    targets.push(target);
    targetsByPr.set(target.pr, targets);
  }

  for (const [prNumber, targets] of targetsByPr) {
    console.log(`\n════ PR#${prNumber} — ${targets.length} target${targets.length === 1 ? '' : 's'} ════`);
    for (const target of targets) {
      console.log(`  • ${target.file} ~L${target.lines.join('/')} — ${target.what}`);
    }
    const { data: pr } = await octokit.rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: prNumber });
    const sha = pr.head.sha;
    const files = await fetchPrDiff(octokit, { owner: OWNER, repo: REPO, number: prNumber }, { maxFileBytes: 120_000, maxFiles: 40, headSha: sha });
    const reviewable = files.filter((f) => f.patch && f.status !== 'removed');

    let context;
    try {
      // Match PRODUCTION context limits (pipeline.ts) so a "never found" verdict
      // isn't just a starved-context artifact. NOTE: this is still a SINGLE
      // MiniMax pass — production runs 3 passes across multiple models + verifier
      // rescue rules — so this remains a LOWER-BOUND proxy: if even this raises a
      // finding, production would too (a drop is conclusively a filter issue); a
      // miss here is only suggestive, not proof production never found it. A
      // faithful classifier needs the full pipeline replay (see ROADMAP Phase 7).
      context = await buildRepoContext(octokit, OWNER, REPO, sha, reviewable.map((f) => f.filename), {
        maxSourceFiles: Number(process.env.ORVEX_CTX_SOURCE ?? 200),
        maxRelated: Number(process.env.ORVEX_CTX_RELATED ?? 18),
        maxDependents: Number(process.env.ORVEX_CTX_DEPENDENTS ?? 12),
        maxFileBytes: Number(process.env.ORVEX_CTX_FILE_BYTES ?? 250_000),
      });
    } catch { /* diff-only */ }

    const resp = await runLlmReview(
      reviewable.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
      { ...llm, context },
    );
    const raw = llmFindingsToReviewFindings(resp.findings);
    const denoised = dropSelfNegatingFindings(raw).kept;

    const ctxFiles = context ? [...context.changedContents, ...context.related, ...context.dependents] : [];
    const prIntent = [pr.title, pr.body].filter(Boolean).join('\n\n');
    let recall: ReviewFinding[] | null = null;
    let strict: ReviewFinding[] | null = null;
    if (ctxFiles.length && denoised.length) {
      recall = (await verifyFindings(denoised, ctxFiles, { ...llm, prIntent, strict: false })).kept;
      strict = (await verifyFindings(denoised, ctxFiles, { ...llm, prIntent, strict: true })).kept;
    }

    for (const target of targets) {
      console.log(`\n  Target: ${target.file} ~L${target.lines.join('/')} — ${target.what}`);
      show('raw model', raw, target);
      show('after noise filter', denoised, target);
      if (recall && strict) {
        show('after RECALL verify', recall, target);
        show('after STRICT verify', strict, target);
      } else {
        console.log('  (no context files or no findings to verify)');
      }
      const rawHit = raw.some((f) => nearTarget(f, target));
      console.log(`  ▶ VERDICT: ${rawHit ? 'RAISED by the model → check which stage drops it (recall-tuning lever)' : 'NEVER RAISED → rules/prompt + context-depth lever'}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
