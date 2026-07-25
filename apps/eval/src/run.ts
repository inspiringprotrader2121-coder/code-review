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
  DEEP_DIVE_FOCUS,
  dropSelfNegatingFindings,
  fingerprintFinding,
  llmFindingsToReviewFindings,
  REVIEW_INCOMPLETE_SUMMARY,
  runLlmReview,
  THIRD_ANGLE_FOCUS,
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

/** LLM target for one production-mirror pass. */
interface PassTarget {
  apiKey: string;
  baseUrl?: string;
  model: string;
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
}

/** Mirror production's multi-model tier: pass 1 the frontier OpenAI model,
 *  pass 2 DeepSeek's heavy reasoning with the deep-dive lens, pass 3 the
 *  standard model with the perf/completeness lens. A missing key falls back to
 *  the standard target for that pass, exactly like modelForPass does. */
function passTargets(): Array<{
  tag: string;
  target: PassTarget;
  focus?: string;
  tier: ReviewFinding['sourceTier'];
  bestEffort?: boolean;
}> {
  const standard = llmEnv();
  const openaiKey = process.env.ORVEX_OPENAI_API_KEY;
  const openai: PassTarget | null = openaiKey
    ? {
        apiKey: openaiKey,
        baseUrl: process.env.ORVEX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: process.env.ORVEX_OPENAI_MODEL ?? 'gpt-5.6-luna',
        api: process.env.ORVEX_OPENAI_API === 'chat' ? 'chat' : 'responses',
        reasoningEffort: process.env.ORVEX_OPENAI_REASONING_EFFORT ?? 'xhigh',
      }
    : null;
  const deepseekKey = process.env.ORVEX_DEEPSEEK_API_KEY;
  const deepseek: PassTarget | null = deepseekKey
    ? {
        apiKey: deepseekKey,
        baseUrl: process.env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: process.env.ORVEX_DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
        reasoningEffort: process.env.ORVEX_DEEPSEEK_EFFORT ?? 'max',
      }
    : null;
  // tier mirrors modelForPass so the verifier's strong-reasoner rescue behaves
  // identically; it degrades with the target when a key is missing.
  return [
    { tag: 'general', target: openai ?? standard, tier: openai ? 'openai' : 'standard' },
    { tag: 'deep-dive', target: deepseek ?? standard, focus: DEEP_DIVE_FOCUS, tier: deepseek ? 'deepseek' : 'standard' },
    // mirrors PASS_ANGLES[2].bestEffort in the pipeline — the only optional pass
    { tag: 'perf/completeness/api', target: standard, focus: THIRD_ANGLE_FOCUS, tier: 'standard', bestEffort: true },
  ];
}

interface PrReviewResult {
  findings: ReviewFinding[];
  /** passes that completed and produced a real (possibly empty) review */
  okPasses: number;
  totalPasses: number;
  /** passes production treats as REQUIRED (it posts nothing if one fails) */
  requiredPasses: number;
  /** required passes that actually completed */
  okRequired: number;
}

async function reviewPr(c: EvalCase): Promise<PrReviewResult> {
  const octokit = await createBenchmarkOctokit(c.owner, c.repo);
  const ref = { owner: c.owner, repo: c.repo, number: c.pr };
  const { data: pr } = await octokit.rest.pulls.get({ owner: c.owner, repo: c.repo, pull_number: c.pr });
  // Ground truth is only true for the commit it was verified against. These PRs
  // are live and get pushed to — and those pushes are FIXES for the very bugs
  // the cases assert, so reviewing head would score a correct reviewer as
  // missing everything, forever, with no signal that anything was wrong.
  const sha = c.sha ?? pr.head.sha;
  if (c.sha && !pr.head.sha.startsWith(c.sha)) {
    console.log(`    ↩ pinned to ${c.sha} (head has moved to ${pr.head.sha.slice(0, 7)})`);
  }

  // Match production (loadWorkerConfig defaults): 150 files / 300kB. At 40/120kB
  // the ground-truth file could be silently dropped and scored as a miss.
  const files = await fetchPrDiff(octokit, ref, {
    maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 300_000),
    maxFiles: Number(process.env.MAX_FILES ?? 150),
    headSha: sha,
  });
  const reviewable = files.filter((f) => f.patch && f.status !== 'removed');
  const passes = passTargets();
  // No reviewable files => nothing was measured. Reporting okPasses=all made
  // every case on this PR score as a genuine model miss.
  const requiredPasses = passes.filter((p) => !p.bestEffort).length;
  if (reviewable.length === 0) {
    return { findings: [], okPasses: 0, totalPasses: passes.length, requiredPasses, okRequired: 0 };
  }

  let context;
  try {
    // Match PRODUCTION context limits so the eval isn't starved relative to what
    // the live pipeline actually gives the model (was 6/4/10KB — far below prod).
    context = await buildRepoContext(octokit, c.owner, c.repo, sha, reviewable.map((f) => f.filename), {
      maxSourceFiles: Number(process.env.ORVEX_CTX_SOURCE ?? 200),
      maxRelated: Number(process.env.ORVEX_CTX_RELATED ?? 18),
      maxDependents: Number(process.env.ORVEX_CTX_DEPENDENTS ?? 12),
      maxFileBytes: Number(process.env.ORVEX_CTX_FILE_BYTES ?? 250_000),
      // MUST be set: buildRepoContext defaults maxOthers to 0, so omitting it gave
      // the model ZERO index-retrieved files while production passes
      // plan.retrievalTopK (28). Every prior eval number was measured without the
      // cross-file retrieval the pipeline actually ships.
      maxOthers: Number(process.env.ORVEX_CTX_OTHERS ?? 28),
    });
  } catch {
    /* diff-only fallback */
  }

  const reviewFiles = reviewable.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch }));
  const baseCtx = { ...(context ?? {}), prTitle: pr.title, prBody: pr.body ?? undefined };

  // Sequential (never concurrent) so eval runs can't trip the OpenAI TPM limit
  // the way the 9-at-once batch did in production.
  const accumulated: ReviewFinding[] = [];
  let okPasses = 0;
  let okRequired = 0;
  for (const p of passes) {
    try {
      const resp = await runLlmReview(reviewFiles, {
        ...p.target,
        context: p.focus ? { ...baseCtx, extraFocus: p.focus } : baseCtx,
      });
      const got = llmFindingsToReviewFindings(resp.findings);
      // Production tags every finding with its tier, which the verifier's
      // strong-reasoner rescue keys off (a hedged veto of an openai/deepseek
      // finding is overridden). Without it that rescue never fires in eval and
      // real findings are recorded as misses.
      for (const f of got) f.sourceTier = p.tier;
      // The unparseable sentinel with zero findings is a DEGRADED pass, not a
      // clean empty review — do not count it as measured.
      const degraded = got.length === 0 && resp.summary === REVIEW_INCOMPLETE_SUMMARY;
      if (!degraded) {
        okPasses++;
        if (!p.bestEffort) okRequired++;
      }
      console.log(`    pass(${p.tag}) [${p.target.model}]: +${got.length}${degraded ? ' (degraded)' : ''}`);
      accumulated.push(...got);
    } catch (err) {
      console.log(`    pass(${p.tag}) [${p.target.model}] FAILED: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  // Same bug from multiple passes → one finding (mirrors the pipeline's dedupe).
  const seenFp = new Set<string>();
  let findings = accumulated.filter((f) => {
    const fp = fingerprintFinding(f);
    if (seenFp.has(fp)) return false;
    seenFp.add(fp);
    return true;
  });

  findings = dropSelfNegatingFindings(findings).kept;

  const ctxFiles = context
    ? [...context.changedContents, ...context.related, ...context.dependents]
    : [];
  if (ctxFiles.length > 0 && findings.length > 0) {
    const std = llmEnv();
    // strict: every plan sets deepVerify: true, so recall-mode verification
    // measured a more permissive filter than ships.
    findings = (
      await verifyFindings(findings, ctxFiles, {
        ...std,
        strict: true,
        prIntent: [pr.title, pr.body].filter(Boolean).join('\n\n'),
      })
    ).kept;
  }
  return { findings, okPasses, totalPasses: passes.length, requiredPasses, okRequired };
}

const SEV_RANK: Record<string, number> = { P1: 3, P2: 2, P3: 1, info: 0 };

function scoreCase(c: EvalCase, findings: ReviewFinding[], claimed?: Set<ReviewFinding>): CaseResult {
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
    // Match the FILE separately from the message, so a path token can't satisfy
    // a content pattern. Normalize whitespace so a multi-line model message
    // doesn't fail a `.*` chain purely on where it wrapped.
    // ONE-TO-ONE binding: a finding already credited to another case on this PR
    // cannot be re-used, which previously let a single finding score 2/2.
    const match = findings.find(
      (f) =>
        !claimed?.has(f) &&
        (req.file ? req.file.test(f.file) : true) &&
        req.pattern.test(`${f.file} ${f.message}`.replace(/\s+/g, ' ')) &&
        (SEV_RANK[f.severity] ?? 0) >= SEV_RANK[req.minSeverity],
    );
    if (match) {
      claimed?.add(match);
      recallHits++;
    } else {
      missing.push(`${req.pattern.source} @≥${req.minSeverity}${req.file ? ` in ${req.file.source}` : ''}`);
    }
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

  let invalidCases = 0;
  let degradedRuns = 0;
  for (const [key, group] of groups) {
    process.stdout.write(`▶ ${key} (${group.length} case${group.length === 1 ? '' : 's'}) …\n`);
    try {
      const { findings, okPasses, totalPasses, requiredPasses, okRequired } = await reviewPr(group[0]);
      console.log(
        `  ${findings.length} findings (${okPasses}/${totalPasses} passes, ${okRequired}/${requiredPasses} required)`,
      );
      // GUARD: if NO pass produced a real review, nothing was measured — the
      // cases are INVALID, not missed. The first bench170 run 404'd on every
      // call yet printed a tidy "recall 0/8"; a harness that can't distinguish
      // "model found nothing" from "model was never reached" lies.
      // Production treats passes 1-2 as REQUIRED and discards the whole review if
      // either fails, so a run missing a core pass is a configuration production
      // would never have posted — INVALID, not merely "degraded".
      if (okPasses > 0 && okPasses < totalPasses) degradedRuns++;
      if (okRequired < requiredPasses) {
        invalidCases += group.length;
        for (const c of group) {
          console.log(`    🚫 ${c.name}: INVALID (${okPasses}/${totalPasses} passes — a required pass failed; excluded from recall)`);
        }
        continue;
      }
      // One finding may satisfy at most ONE case per PR.
      const claimed = new Set<ReviewFinding>();
      for (const c of group) {
        const r = scoreCase(c, findings, claimed);
        results.push(r);
        const parts: string[] = [];
        if (r.recallTotal) parts.push(`recall ${r.recallHits}/${r.recallTotal}`);
        if (c.shouldNotFlag?.length) parts.push(`${r.falsePositives === 0 ? 'no' : r.falsePositives} false-pos`);
        console.log(`    ${r.falsePositives === 0 && r.recallHits === r.recallTotal ? '✅' : '⚠️'} ${c.name}: ${parts.join(', ')}`);
        for (const m of r.missing) console.log(`       ✗ missed: /${m}/`);
        for (const fp of r.falsePos) console.log(`       ✗ false positive: /${fp}/`);
      }
    } catch (err) {
      invalidCases += group.length;
      console.log(`  🚫 ERROR — ${group.length} case(s) INVALID: ${(err as Error).message}`);
    }
  }

  const recallHits = results.reduce((a, r) => a + r.recallHits, 0);
  const recallTotal = results.reduce((a, r) => a + r.recallTotal, 0);
  const fp = results.reduce((a, r) => a + r.falsePositives, 0);
  const fpChecks = results.reduce((a, r) => a + ((CASES.find((c) => c.name === r.name)?.shouldNotFlag?.length) ?? 0), 0);
  console.log('\n── summary ──');
  console.log(`recall:    ${recallHits}/${recallTotal} real bugs caught`);
  console.log(`precision: ${fpChecks - fp}/${fpChecks} noise checks passed (${fp} false positives)`);
  if (degradedRuns > 0) {
    console.log(`⚠️ ${degradedRuns} PR(s) ran with a DEGRADED pipeline (some passes failed) — recall understated`);
  }
  if (invalidCases > 0) {
    console.log(`⚠️ INVALID: ${invalidCases} case(s) not measured (harness/provider failure) — fix before trusting this run`);
    process.exitCode = 1;
  }
  if (results.length === 0) {
    console.error('\nEVAL FAILED: zero cases were actually measured.');
    process.exitCode = 1;
  }
}

// Preserve process.exitCode — `process.exit(0)` overrode the INVALID guard, so a
// run where every case failed to execute still exited green.
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
