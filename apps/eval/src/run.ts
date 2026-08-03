/**
 * Offline eval harness: replay labeled PRs through the review core (no posting)
 * and score precision/recall against the ground-truth cases. Run on the server
 * where the GitHub + LLM keys live:  pnpm --filter @orvex-review/eval eval
 */
import { pathToFileURL } from 'node:url';
import {
  buildRepoContext,
  fetchPrDiff,
} from '@orvex-review/github';
import {
  DEEP_DIVE_FOCUS,
  aggregateRepeatedFindings,
  dropSelfNegatingFindings,
  fitReviewAggregationToBudget,
  fingerprintFinding,
  llmChat,
  llmFindingsToReviewFindings,
  partitionVerifiedFindings,
  readReviewAggregationConfig,
  REVIEW_INCOMPLETE_SUMMARY,
  runLlmReview,
  REMOVED_BEHAVIOR_FOCUS,
  THIRD_ANGLE_FOCUS,
  verifyFindings,
  type ReviewFinding,
  type ReviewSurfaceFinding,
} from '@orvex-review/review';
import { CASES, evaluationCorpusFingerprint, evaluationCorpusLabelCounts, type EvalCase } from './cases.js';
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

/** LLM target for one production-mirror pass. */
interface PassTarget {
  apiKey: string;
  baseUrl?: string;
  model: string;
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
}

function configuredApi(
  env: NodeJS.ProcessEnv,
  variable: 'ORVEX_STANDARD_API' | 'MINIMAX_API',
  baseUrl: string,
): NonNullable<PassTarget['api']> {
  const configured = env[variable];
  if (configured === 'anthropic' || configured === 'responses' || configured === 'chat') return configured;
  return baseUrl.includes('/anthropic') ? 'anthropic' : 'chat';
}

function llmEnv(env: NodeJS.ProcessEnv = process.env): PassTarget {
  // Prefer the production 'standard' target (what real reviews run on) so the
  // eval measures the same model+endpoint. MINIMAX_API=anthropic (or an
  // /anthropic base URL) must route via the Anthropic-compatible client —
  // POSTing chat/completions at that base 404s and the whole eval silently
  // scores 0/N (2026-07-23: every call returned "404 page not found").
  const stdKey = env.ORVEX_STANDARD_API_KEY;
  const minimax = env.MINIMAX_API_KEY;
  const anthropic = env.ANTHROPIC_API_KEY;
  if (stdKey) {
    const baseUrl = env.ORVEX_STANDARD_BASE_URL ?? 'https://api.minimax.io/v1';
    return {
      apiKey: stdKey,
      baseUrl,
      model: env.ORVEX_STANDARD_MODEL ?? 'MiniMax-M3',
      api: configuredApi(env, 'ORVEX_STANDARD_API', baseUrl),
    };
  }
  if (minimax) {
    const baseUrl = env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1';
    return {
      apiKey: minimax,
      baseUrl,
      model: env.MINIMAX_MODEL ?? 'MiniMax-M3',
      api: configuredApi(env, 'MINIMAX_API', baseUrl),
    };
  }
  if (!anthropic) throw new Error('ORVEX_STANDARD_API_KEY, MINIMAX_API_KEY or ANTHROPIC_API_KEY required');
  return { apiKey: anthropic, baseUrl: undefined, model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514' };
}

function openAiTarget(env: NodeJS.ProcessEnv = process.env): PassTarget | null {
  const apiKey = env.ORVEX_OPENAI_API_KEY;
  return apiKey
    ? {
        apiKey,
        baseUrl: env.ORVEX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: env.ORVEX_OPENAI_MODEL ?? 'gpt-5.6-luna',
        api: env.ORVEX_OPENAI_API === 'chat' ? 'chat' : 'responses',
        reasoningEffort: env.ORVEX_OPENAI_REASONING_EFFORT ?? 'xhigh',
      }
    : null;
}

/** Mirrors pipeline.ts modelForPlan for the production multi-model tier. */
function verifierTarget(env: NodeJS.ProcessEnv = process.env): PassTarget {
  const openai = openAiTarget(env);
  return openai && env.ORVEX_VERIFY_ON_STANDARD !== '1' ? openai : llmEnv(env);
}

/** Mirror production's multi-model tier (modelForPass + PASS_ANGLES), pass for
 *  pass: 1 the frontier OpenAI model, 2 DeepSeek v4 FLASH with the deep-dive
 *  lens, 3 DeepSeek v4 PRO with the removed-behavior/caller lens, 4 the
 *  standard model with the perf/completeness lens. A missing key falls back to
 *  the standard target for that pass, exactly like modelForPass does.
 *
 *  This drifted twice and both times silently invalidated the benchmark: the
 *  eval ran three passes while the multi-model tier ran four (so bench170 was
 *  scored WITHOUT the removed-behavior lens that was built to catch it), and
 *  deep-dive was pointed at v4 Pro after production moved it to v4 Flash. If
 *  you change modelForPass or PASS_ANGLES, change this in the same commit —
 *  otherwise every number this harness prints describes a pipeline that does
 *  not exist. */
export function evaluationPassTargets(env: NodeJS.ProcessEnv = process.env): Array<{
  tag: string;
  target: PassTarget;
  focus?: string;
  tier: ReviewFinding['sourceTier'];
  bestEffort?: boolean;
}> {
  const standard = llmEnv(env);
  const openai = openAiTarget(env);
  const deepseekKey = env.ORVEX_DEEPSEEK_API_KEY;
  const deepseek: PassTarget | null = deepseekKey
    ? {
        apiKey: deepseekKey,
        baseUrl: env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: env.ORVEX_DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
        reasoningEffort: env.ORVEX_DEEPSEEK_EFFORT ?? 'max',
      }
    : null;
  // v4 Flash shares the DeepSeek key/base URL — only the model id differs, which
  // is why production runs both as independent reasoners on different lenses.
  const deepseekFlash: PassTarget | null = deepseekKey
    ? {
        apiKey: deepseekKey,
        baseUrl: env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: env.ORVEX_DEEPSEEK_FLASH_MODEL ?? 'deepseek-v4-flash',
        reasoningEffort: env.ORVEX_DEEPSEEK_FLASH_EFFORT ?? 'max',
      }
    : null;
  // tier mirrors modelForPass so the verifier's strong-reasoner rescue behaves
  // identically; it degrades with the target when a key is missing.
  return [
    { tag: 'general', target: openai ?? standard, tier: openai ? 'openai' : 'standard' },
    // pass 2 → FLASH, matching modelForPass: it currently outperforms v4 Pro, so
    // it gets the highest-value lens.
    { tag: 'deep-dive', target: deepseekFlash ?? standard, focus: DEEP_DIVE_FOCUS, tier: deepseekFlash ? 'deepseek-flash' : 'standard' },
    // pass 3 → PRO on the removed-behavior/caller lens. A second INDEPENDENT
    // reasoner, not a re-run; this is the lens the 161-180 misses motivated.
    { tag: 'removed-behavior/callers', target: deepseek ?? standard, focus: REMOVED_BEHAVIOR_FOCUS, tier: deepseek ? 'deepseek' : 'standard' },
    // mirrors the pipeline's BREADTH_ANGLE bestEffort — the only optional pass
    { tag: 'perf/completeness/api', target: standard, focus: THIRD_ANGLE_FOCUS, tier: 'standard', bestEffort: true },
  ];
}

interface PrReviewResult {
  findings: ReviewFinding[];
  /** Candidates production keeps on the manual-review surface, excluded from scored normal findings. */
  manualReviewCount: number;
  /** passes that completed and produced a real (possibly empty) review */
  okPasses: number;
  totalPasses: number;
  /** minimum required samples production needs before it will post a review */
  requiredPasses: number;
  /** required samples that actually completed */
  okRequired: number;
}

async function reviewPr(c: EvalCase): Promise<PrReviewResult> {
  const octokit = await createBenchmarkOctokit(c.owner, c.repo);
  const ref = { owner: c.owner, repo: c.repo, number: c.pr };
  // Ground truth is only true for the commit it was verified against. These PRs
  // are live and get pushed to — and those pushes are FIXES for the very bugs
  // the cases assert, so reviewing head would score a correct reviewer as
  // missing everything, forever, with no signal that anything was wrong.
  const sha = c.sha;
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`eval case ${c.name} has no immutable 40-character SHA`);
  }
  if (!/^[0-9a-f]{40}$/i.test(c.baseSha) || c.baseSha === sha) {
    throw new Error(`eval case ${c.name} has no distinct immutable base SHA`);
  }

  // Pin BOTH sides of the comparison. Supplying only headSha falls back to
  // GitHub's mutable current-PR file list, which can mismatch historical source
  // context and invalidate the label's precision/recall result.
  const files = await fetchPrDiff(octokit, ref, {
    maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 300_000),
    maxFiles: Number(process.env.MAX_FILES ?? 150),
    sinceSha: c.baseSha,
    headSha: sha,
  });
  const reviewable = files.filter((f) => f.patch && f.status !== 'removed');
  const passes = evaluationPassTargets();
  const requestedAggregation = readReviewAggregationConfig();
  const configuredMaxCalls = Number(process.env.ORVEX_REVIEW_MAX_CALLS ?? 28);
  const maxCalls = Number.isFinite(configuredMaxCalls) ? Math.max(1, Math.floor(configuredMaxCalls)) : 28;
  // The multi-model production tier has no whole-repo sweep today, so no calls
  // are reserved here. Keep the same bounded policy as the worker nonetheless.
  const aggregation = fitReviewAggregationToBudget(requestedAggregation, passes.length, maxCalls);
  if (requestedAggregation.enabled && !aggregation.enabled) {
    console.log(`    aggregation disabled: ${aggregation.disabledReason}`);
  }
  const samples = aggregation.enabled ? aggregation.effectiveRuns : 1;
  const requiredPerLens = aggregation.enabled ? aggregation.minOccurrences : 1;
  // No reviewable files => nothing was measured. Reporting okPasses=all made
  // every case on this PR score as a genuine model miss.
  const requiredPasses = passes.filter((p) => !p.bestEffort).length * requiredPerLens;
  if (reviewable.length === 0) {
    return {
      findings: [],
      manualReviewCount: 0,
      okPasses: 0,
      totalPasses: passes.length * samples,
      requiredPasses,
      okRequired: 0,
    };
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
  // Mirror production: first-pass reviewers do not receive author intent.
  const baseCtx = { ...(context ?? {}) };

  // Sequential (never concurrent) so eval runs can't trip the OpenAI TPM limit
  // the way the 9-at-once batch did in production.
  const accumulated: ReviewFinding[] = [];
  const repeated: Array<{ sample: number; finding: ReviewFinding }> = [];
  let okPasses = 0;
  const successfulRequiredByLens = new Map<number, number>();
  for (let sample = 0; sample < samples; sample++) {
    for (const [passIndex, p] of passes.entries()) {
      try {
        const resp = await runLlmReview(reviewFiles, {
          ...p.target,
          temperature: aggregation.enabled ? aggregation.temperature : undefined,
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
          if (!p.bestEffort) {
            successfulRequiredByLens.set(passIndex, (successfulRequiredByLens.get(passIndex) ?? 0) + 1);
          }
          if (aggregation.enabled) repeated.push(...got.map((finding) => ({ sample, finding })));
        }
        console.log(
          `    pass(${p.tag}) [${p.target.model}] sample ${sample + 1}/${samples}: +${got.length}${degraded ? ' (degraded)' : ''}`,
        );
        if (!aggregation.enabled) accumulated.push(...got);
      } catch (err) {
        console.log(
          `    pass(${p.tag}) [${p.target.model}] sample ${sample + 1}/${samples} FAILED: ` +
            `${(err as Error).message.slice(0, 120)}`,
        );
      }
    }
  }
  const okRequired = [...successfulRequiredByLens.values()].reduce(
    (total, successes) => total + Math.min(successes, requiredPerLens),
    0,
  );

  // Same bug from multiple passes → one finding (mirrors the pipeline's dedupe).
  const seenFp = new Set<string>();
  const dedupe = (candidates: ReviewFinding[]) => candidates.filter((f) => {
    const fp = fingerprintFinding(f);
    if (seenFp.has(fp)) return false;
    seenFp.add(fp);
    return true;
  });
  let findings: ReviewFinding[];
  let manualCandidates: ReviewSurfaceFinding[] = [];
  if (aggregation.enabled) {
    const target = verifierTarget();
    const merged = await aggregateRepeatedFindings(repeated, {
      minOccurrences: aggregation.minOccurrences,
      maxCandidates: aggregation.maxCandidates,
      mergeWithLlm: (system, user) =>
        llmChat(system, user, {
          ...target,
          temperature: aggregation.temperature,
          json: true,
        }),
    });
    findings = dedupe(merged.findings);
    manualCandidates = merged.reviewOnly;
    console.log(
      `    aggregation: ${merged.findings.length} recurring, ${merged.reviewOnly.length} manual, ` +
        `${merged.usedLlmMerge ? 'LLM merge' : 'fingerprint fallback'}`,
    );
  } else {
    findings = dedupe(accumulated);
  }

  findings = dropSelfNegatingFindings(findings).kept;
  const keptManual = new Set(
    dropSelfNegatingFindings(manualCandidates.map(({ finding }) => finding)).kept.map(fingerprintFinding),
  );
  manualCandidates = manualCandidates.filter(({ finding }) => keptManual.has(fingerprintFinding(finding)));

  const ctxFiles = context
    ? [...context.changedContents, ...context.related, ...context.dependents, ...context.others]
    : [];
  const contextPaths = new Set(ctxFiles.map((file) => file.path));
  for (const file of reviewFiles) {
    if (!contextPaths.has(file.filename) && file.patch) {
      ctxFiles.push({ path: file.filename, content: `Diff (changed lines) for this file:\n${file.patch}` });
      contextPaths.add(file.filename);
    }
  }
  let manualReviewCount = manualCandidates.length;
  const verificationCandidates = [...findings, ...manualCandidates.map(({ finding }) => finding)];
  if (ctxFiles.length > 0 && verificationCandidates.length > 0) {
    // strict: every plan sets deepVerify: true. Use the same OpenAI-vs-standard
    // target selection as production rather than measuring a cheaper verifier.
    const verified = await verifyFindings(verificationCandidates, ctxFiles, {
      ...verifierTarget(),
      strict: true,
      confirmedCount: findings.length,
    });
    // Apply the exact post-verifier partition used by production. A candidate
    // that the verifier demotes stays visible for manual review, but it does not
    // inflate normal-surface precision/recall.
    const disposition = partitionVerifiedFindings(findings, manualCandidates, verified);
    if (disposition.rescued.length > 0) {
      console.log(`    ↺ rescued ${disposition.rescued.length} strong-reasoner finding(s) dropped on hedged grounds`);
    }
    findings = disposition.toPost;
    manualReviewCount = disposition.reviewOnly.length;
  }
  return { findings, manualReviewCount, okPasses, totalPasses: passes.length * samples, requiredPasses, okRequired };
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
  const labels = evaluationCorpusLabelCounts(CASES);
  console.log(
    `corpus sha256: ${evaluationCorpusFingerprint(CASES)} ` +
      `(${CASES.length} cases; ${labels.positive} positive and ${labels.negative} negative labels; ${cases.length} selected)`,
  );
  const results: CaseResult[] = [];

  const groups = new Map<string, EvalCase[]>();
  for (const c of cases) {
    const key = `${c.owner}/${c.repo}#${c.pr}@${c.baseSha}...${c.sha}`;
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }

  let invalidCases = 0;
  let degradedRuns = 0;
  for (const [key, group] of groups) {
    process.stdout.write(`▶ ${key} (${group.length} case${group.length === 1 ? '' : 's'}) …\n`);
    try {
      const { findings, manualReviewCount, okPasses, totalPasses, requiredPasses, okRequired } = await reviewPr(group[0]);
      console.log(
        `  ${findings.length} normal findings, ${manualReviewCount} manual candidates (${okPasses}/${totalPasses} passes, ${okRequired}/${requiredPasses} required)`,
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
const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
