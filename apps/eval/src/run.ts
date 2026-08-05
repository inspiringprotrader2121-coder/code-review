/**
 * Offline eval harness: replay labeled PRs through the review core (no posting)
 * and score precision/recall against the ground-truth cases. Run on the server
 * where the GitHub + LLM keys live:  pnpm --filter @orvex-review/eval eval
 */
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  formatModelContribution,
  llmChat,
  llmFindingsToReviewFindings,
  partitionVerifiedFindings,
  readReviewAggregationConfig,
  REVIEW_INCOMPLETE_SUMMARY,
  runInvestigateReview,
  runLlmReview,
  REMOVED_BEHAVIOR_FOCUS,
  summarizeModelContribution,
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
  // When the API is declared anthropic-shaped but no base URL is given, the
  // default must be the /anthropic endpoint (mirrors production loadWorkerConfig)
  // — an Anthropic client pointed at /v1 fails on every call.
  const defaultBase = (apiVar: string | undefined): string =>
    apiVar === 'anthropic' ? 'https://api.minimax.io/anthropic' : 'https://api.minimax.io/v1';
  if (stdKey) {
    const baseUrl = env.ORVEX_STANDARD_BASE_URL ?? defaultBase(env.ORVEX_STANDARD_API);
    return {
      apiKey: stdKey,
      baseUrl,
      model: env.ORVEX_STANDARD_MODEL ?? 'MiniMax-M3',
      api: configuredApi(env, 'ORVEX_STANDARD_API', baseUrl),
    };
  }
  if (minimax) {
    const baseUrl = env.MINIMAX_BASE_URL ?? defaultBase(env.MINIMAX_API);
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

/** Mirrors pipeline.ts modelForPlanWithTier for the production multi-model tier. */
export function evaluationVerifier(
  env: NodeJS.ProcessEnv = process.env,
): { target: PassTarget; tier: ReviewFinding['sourceTier'] } {
  if (env.ORVEX_VERIFY_ON_STANDARD === '1') {
    return { target: llmEnv(env), tier: 'standard' };
  }
  if (env.ORVEX_VERIFY_ON_OPENAI === '1') {
    const openai = openAiTarget(env);
    if (openai) return { target: openai, tier: 'openai' };
  }
  const deepseekKey = env.ORVEX_DEEPSEEK_API_KEY;
  if (deepseekKey) {
    if (env.ORVEX_VERIFY_ON_DEEPSEEK_PRO === '1') {
      return {
        target: {
          apiKey: deepseekKey,
          baseUrl: env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
          model: env.ORVEX_DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
          reasoningEffort: env.ORVEX_DEEPSEEK_EFFORT ?? 'max',
        },
        tier: 'deepseek',
      };
    }
    return {
      target: {
        apiKey: deepseekKey,
        baseUrl: env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: env.ORVEX_DEEPSEEK_FLASH_MODEL ?? 'deepseek-v4-flash',
        reasoningEffort: env.ORVEX_DEEPSEEK_FLASH_EFFORT ?? 'max',
      },
      tier: 'deepseek-flash',
    };
  }
  return { target: llmEnv(env), tier: 'standard' };
}

/** Mirror production's multi-model tier (modelForPass + PASS_ANGLES), pass for
 *  pass: 1 the frontier OpenAI model, 2 DeepSeek v4 FLASH with the deep-dive
 *  lens, 3 DeepSeek v4 FLASH with the removed-behavior/caller lens (Pro via
 *  ORVEX_PASS3_ON_DEEPSEEK_PRO=1), 4 the standard model with the
 *  perf/completeness lens. A missing key falls back to the standard target for
 *  that pass, exactly like modelForPass does.
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
    // pass 3 → FLASH on the removed-behavior/caller lens by default (cheap second
    // angle). Set ORVEX_PASS3_ON_DEEPSEEK_PRO=1 to restore Pro for ablation.
    {
      tag: 'removed-behavior/callers',
      target:
        env.ORVEX_PASS3_ON_DEEPSEEK_PRO === '1'
          ? (deepseek ?? deepseekFlash ?? standard)
          : (deepseekFlash ?? deepseek ?? standard),
      focus: REMOVED_BEHAVIOR_FOCUS,
      tier:
        env.ORVEX_PASS3_ON_DEEPSEEK_PRO === '1'
          ? (deepseek ? 'deepseek' : deepseekFlash ? 'deepseek-flash' : 'standard')
          : (deepseekFlash ? 'deepseek-flash' : deepseek ? 'deepseek' : 'standard'),
    },
    // mirrors the pipeline's BREADTH_ANGLE bestEffort — the only optional pass
    { tag: 'perf/completeness/api', target: standard, focus: THIRD_ANGLE_FOCUS, tier: 'standard', bestEffort: true },
  ];
}

/**
 * Whether offline eval should run the sandboxed investigate pass.
 * Eval measures the multi-model (Verify*) track; investigate is on for that
 * track when a target resolves (mirrors production canRunInvestigate for
 * multi-model with Codex off). Kill-switch: ORVEX_INVESTIGATE=0.
 */
export function evaluationInvestigateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ORVEX_INVESTIGATE === '0') return false;
  return evaluationInvestigateTarget(env) !== null;
}

/** DeepSeek Flash target used by production investigate (modelForInvestigate).
 *  Honors ORVEX_INVESTIGATE_TIER the same way production does. */
export function evaluationInvestigateTarget(env: NodeJS.ProcessEnv = process.env): {
  target: PassTarget;
  tier: ReviewFinding['sourceTier'];
} | null {
  const override = (env.ORVEX_INVESTIGATE_TIER ?? 'deepseek-flash').trim().toLowerCase();
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
  const deepseekFlash: PassTarget | null = deepseekKey
    ? {
        apiKey: deepseekKey,
        baseUrl: env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: env.ORVEX_DEEPSEEK_FLASH_MODEL ?? 'deepseek-v4-flash',
        reasoningEffort: env.ORVEX_DEEPSEEK_FLASH_EFFORT ?? 'max',
      }
    : null;
  const standard = (() => {
    try {
      return llmEnv(env);
    } catch {
      return null;
    }
  })();

  if (override === 'openai' && openai) return { target: openai, tier: 'openai' };
  if (override === 'deepseek' && deepseek) return { target: deepseek, tier: 'deepseek' };
  if (override === 'standard' && standard) return { target: standard, tier: 'standard' };
  if (deepseekFlash) return { target: deepseekFlash, tier: 'deepseek-flash' };
  if (deepseek) return { target: deepseek, tier: 'deepseek' };
  if (openai) return { target: openai, tier: 'openai' };
  if (standard) return { target: standard, tier: 'standard' };
  return null;
}

const INVESTIGATE_PASS_FOCUS =
  'INVESTIGATE PASS — P1-FIRST multi-hop search with tools. Prioritize only ' +
  'Critical/High defects this PR introduces or exposes: auth/authz bypass, data ' +
  'loss/corruption, resource leak on failure, asymmetric error paths (success records ' +
  'X but failure skips it), dead checks after refactor, post-transform null/inconsistency, ' +
  'and cross-tenant/identity scoping bugs. Procedure: (1) list symbols this diff deletes ' +
  'or renames and grep their remaining callers; (2) for each changed function, read its ' +
  'full body + immediate callers/callees; (3) compare success vs failure/cleanup paths; ' +
  '(4) kill hypotheses that the code already handles. Report only concrete P1/P2 bugs ' +
  'with file:line and a failure scenario — no style/nits.';

/** Temp checkout at `sha` for the investigate tool loop (same idea as pipeline). */
async function checkoutEvalRepo(
  octokit: Awaited<ReturnType<typeof createBenchmarkOctokit>>,
  owner: string,
  repo: string,
  sha: string,
): Promise<string | null> {
  let dir: string | null = null;
  try {
    const res = await octokit.rest.repos.downloadTarballArchive({ owner, repo, ref: sha });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-eval-'));
    const tarPath = path.join(dir, 'repo.tar.gz');
    fs.writeFileSync(tarPath, Buffer.from(res.data as ArrayBuffer));
    execFileSync('tar', ['-xzf', tarPath, '-C', dir, '--strip-components=1'], { stdio: 'ignore' });
    fs.rmSync(tarPath, { force: true });
    return dir;
  } catch (err) {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    console.log(`    investigate checkout failed: ${(err as Error).message.slice(0, 120)}`);
    return null;
  }
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
  const investigateFiles = files
    .filter((f) => f.patch)
    .map((f) => ({ filename: f.filename, status: f.status, patch: f.patch }));
  const passes = evaluationPassTargets();
  const wantInvestigate = evaluationInvestigateEnabled();
  const investigate = wantInvestigate ? evaluationInvestigateTarget() : null;
  const reservedInvestigate = wantInvestigate && investigate ? 1 : 0;
  const requestedAggregation = readReviewAggregationConfig();
  const configuredMaxCalls = Number(process.env.ORVEX_REVIEW_MAX_CALLS ?? 28);
  const maxCalls = Number.isFinite(configuredMaxCalls) ? Math.max(1, Math.floor(configuredMaxCalls)) : 28;
  // Reserve one slot for investigate when enabled (mirrors pipeline reservedFixedCalls).
  const aggregation = fitReviewAggregationToBudget(
    requestedAggregation,
    passes.length,
    maxCalls,
    reservedInvestigate,
  );
  if (requestedAggregation.enabled && !aggregation.enabled) {
    console.log(`    aggregation disabled: ${aggregation.disabledReason}`);
  }
  const samples = aggregation.enabled ? aggregation.effectiveRuns : 1;
  // Production aborts only when a required lens has ZERO successes. Aggregation
  // under-sampling (below minOccurrences) degrades and still posts — so INVALID
  // here must match that (≥1 success per required lens), not require full
  // minOccurrences or flaky samples discard cases production would score.
  const requiredLensIndexes = passes
    .map((p, index) => (p.bestEffort ? -1 : index))
    .filter((index) => index >= 0);
  const requiredPasses = requiredLensIndexes.length;
  if (reviewable.length === 0) {
    return {
      findings: [],
      manualReviewCount: 0,
      okPasses: 0,
      totalPasses: passes.length * samples + reservedInvestigate,
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
        for (const f of got) {
          f.sourceTier = p.tier;
          f.sourcePass = p.tag;
        }
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

  // Sandboxed investigate pass — production differentiator for Greptile-class
  // multi-hop P1s. Single-shot (not aggregated); findings unioned after merge.
  const investigateFindings: ReviewFinding[] = [];
  if (reservedInvestigate && investigate) {
    const cwd = await checkoutEvalRepo(octokit, c.owner, c.repo, sha);
    if (cwd) {
      try {
        const resp = await runInvestigateReview(investigateFiles, {
          cwd,
          apiKey: investigate.target.apiKey,
          model: investigate.target.model,
          baseUrl: investigate.target.baseUrl,
          api: investigate.target.api,
          reasoningEffort: investigate.target.reasoningEffort,
          context: { ...baseCtx, extraFocus: INVESTIGATE_PASS_FOCUS },
        });
        const got = llmFindingsToReviewFindings(resp.findings);
        for (const f of got) {
          f.sourceTier = investigate.tier;
          f.sourcePass = 'investigate';
        }
        const degraded = got.length === 0 && resp.summary === REVIEW_INCOMPLETE_SUMMARY;
        if (!degraded) {
          okPasses++;
          investigateFindings.push(...got);
        }
        console.log(
          `    pass(investigate) [${investigate.target.model}]: +${got.length}${degraded ? ' (degraded)' : ''}`,
        );
      } catch (err) {
        console.log(`    pass(investigate) [${investigate.target.model}] FAILED: ${(err as Error).message.slice(0, 120)}`);
      } finally {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    } else {
      console.log('    pass(investigate) skipped: checkout unavailable');
    }
  }

  const okRequired = requiredLensIndexes.filter(
    (index) => (successfulRequiredByLens.get(index) ?? 0) >= 1,
  ).length;
  const underSampled =
    aggregation.enabled
    && requiredLensIndexes.some(
      (index) => (successfulRequiredByLens.get(index) ?? 0) < aggregation.minOccurrences,
    );
  if (underSampled) {
    console.log(
      `    aggregation under-sampled (degraded, still scoring — mirrors production disclosure)`,
    );
  }

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
    const target = evaluationVerifier().target;
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
    // Investigate is single-shot — union like production (do not demote via minOccurrences).
    findings = dedupe([...merged.findings, ...investigateFindings]);
    manualCandidates = merged.reviewOnly;
    console.log(
      `    aggregation: ${merged.findings.length} recurring, ${merged.reviewOnly.length} manual, ` +
        `${merged.usedLlmMerge ? 'LLM merge' : 'fingerprint fallback'}` +
        (investigateFindings.length ? `, ${investigateFindings.length} investigate` : ''),
    );
  } else {
    findings = dedupe([...accumulated, ...investigateFindings]);
  }

  const contributionSource = aggregation.enabled
    ? [...repeated.map((r) => r.finding), ...investigateFindings]
    : [...accumulated, ...investigateFindings];
  console.log(
    `    model contribution (pre-dedupe): ${formatModelContribution(summarizeModelContribution(contributionSource))}`,
  );
  console.log(
    `    model contribution (unique): ${formatModelContribution(summarizeModelContribution(findings))}`,
  );

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
  if (
    process.env.ORVEX_VERIFY !== '0'
    && ctxFiles.length > 0
    && verificationCandidates.length > 0
  ) {
    // strict: every plan sets deepVerify: true. Use the same OpenAI-vs-standard
    // target selection as production rather than measuring a cheaper verifier.
    const verifier = evaluationVerifier();
    const verified = await verifyFindings(verificationCandidates, ctxFiles, {
      ...verifier.target,
      strict: true,
      confirmedCount: findings.length,
      verifierTier: verifier.tier,
    });
    // Apply the exact post-verifier partition used by production. A candidate
    // that the verifier demotes stays visible for manual review, but it does not
    // inflate normal-surface precision/recall.
    const disposition = partitionVerifiedFindings(findings, manualCandidates, verified, {
      verifierTier: verifier.tier,
    });
    if (disposition.rescued.length > 0) {
      console.log(`    ↺ rescued ${disposition.rescued.length} strong-reasoner finding(s) dropped on hedged grounds`);
    }
    findings = disposition.toPost;
    manualReviewCount = disposition.reviewOnly.length;
  } else if (process.env.ORVEX_VERIFY === '0' && verificationCandidates.length > 0) {
    console.log('    verification skipped (ORVEX_VERIFY=0)');
  }
  console.log(
    `    model contribution (posted): ${formatModelContribution(summarizeModelContribution(findings))}`,
  );
  return {
    findings,
    manualReviewCount,
    okPasses,
    totalPasses: passes.length * samples + reservedInvestigate,
    requiredPasses,
    okRequired,
  };
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
