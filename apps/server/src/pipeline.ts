import {
  buildRepoContext,
  createInstallationOctokit,
  createCheckRun,
  fetchFileContent,
  fetchPrDiffWithCoverage,
  fetchPrLabels,
  fetchPullRequest,
  fetchRepoFile,
  hasIgnoreLabel,
  isPrStillOpen,
  isRepoAllowed,
  loadGitHubConfigFromEnv,
  postPullRequestReview,
  replyToReviewComment,
  replyToIssueComment,
  shouldSkipPr,
  type GitHubAppConfig,
  type InlineReviewComment,
} from '@orvex-review/github';
import type { ReviewJobPayload } from '@orvex-review/queue';
import {
  auditFindingsFromContent,
  parseReviewConfigYaml,
  runSemgrepOnPaths,
  shouldIgnorePath,
  type ReviewConfig,
} from '@orvex-review/rules';
import {
  applyCheckboxLine,
  checkImportBindings,
  commandTrigger,
  dedupeByFileLine,
  DEEP_DIVE_FOCUS,
  REMOVED_BEHAVIOR_FOCUS,
  THIRD_ANGLE_FOCUS,
  filterAndCapFindings,
  fingerprintFinding,
  fitReviewAggregationToBudget,
  formatFixedReply,
  formatInlineFinding,
  formatReviewBody,
  llmFindingsToReviewFindings,
  isTransientLlmError,
  llmChat,
  REVIEW_INCOMPLETE_SUMMARY,
  mergeFindings,
  aggregateRepeatedFindings,
  readReviewAggregationConfig,
  partitionVerifiedFindings,
  reconcileFixedOnHead,
  dropSelfNegatingFindings,
  runLlmReview,
  runCodexCliReview,
  runInvestigateReview,
  isCodexRepoAllowed,
  DEFAULT_CODEX_CLI_MODEL,
  DEFAULT_CODEX_CLI_REASONING_EFFORT,
  toStoredFinding,
  verifyFindings,
  type ReviewFinding,
  type ReviewPromptContext,
  type ReviewSurfaceFinding,
  summarizeModelContribution,
  formatModelContribution,
} from '@orvex-review/review';
import {
  createAppDatabase,
  type AppDatabase,
  type PrReviewState,
  type StoredFinding,
} from '@orvex-review/store';
import { planFeatures } from '@orvex-review/tenants';
import { reportStripeReviewOverage } from './routes/billing.js';
import { runtimeVerify, formatRuntimeEvidence } from './runtime-verify.js';
import { formatLimitBlockedComment, loadAccountQuotaStatus } from './quota-status.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Download + extract the repo at `ref` into a temp dir for agentic exploration
 * (Codex CLI or the sandboxed investigate tier). Fail-safe: returns null on any
 * error and the review falls back to diff+context only.
 */
async function checkoutRepoForAgent(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  let dir: string | null = null;
  try {
    const res = await octokit.rest.repos.downloadTarballArchive({ owner, repo, ref });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-repo-'));
    const tarPath = path.join(dir, 'repo.tar.gz');
    fs.writeFileSync(tarPath, Buffer.from(res.data as ArrayBuffer));
    // GitHub tarballs nest everything under a top-level `owner-repo-sha/` dir.
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
    console.warn('[worker] repo checkout failed (diff-only fallback):', (err as Error).message);
    return null;
  }
}

export interface LlmTarget {
  apiKey: string;
  /** Provider base URL. */
  baseUrl?: string;
  model: string;
  /** Provider wire protocol. */
  api?: 'chat' | 'responses' | 'anthropic';
  /** reasoning effort for /v1/responses models ('low'|'medium'|'high'|'xhigh') */
  reasoningEffort?: string;
}

export interface WorkerConfig {
  github: GitHubAppConfig;
  llmApiKey: string;
  /** set for OpenAI-compatible providers (MiniMax); unset means Anthropic */
  llmBaseUrl?: string;
  llmApi?: 'chat' | 'responses' | 'anthropic';
  llmModel: string;
  /** the cheaper 'standard' model (MiniMax) for Review/Free tiers; falls back to
   *  the premium model when ORVEX_STANDARD_* is not configured. */
  standardModel: LlmTarget;
  /** optional OpenAI model (e.g. gpt-5.3-codex via /v1/responses) for tiers with
   *  modelTier 'openai'; null when ORVEX_OPENAI_API_KEY is not set. */
  openaiModel: LlmTarget | null;
  /** optional Codex CLI target (OAuth/login) used when ORVEX_CODEX_CLI=1; null
   *  when the CLI path is disabled. */
  codexCliModel: LlmTarget | null;
  /** DeepSeek v4 Flash — a SECOND, independent DeepSeek reasoner on the same
   *  key. Distinct model weights, so it is genuine ensemble diversity rather
   *  than a re-run of v4 Pro. */
  deepseekFlashModel: LlmTarget | null;
  /** optional DeepSeek model (reasoning-heavy, cheap) — a standalone pass
   *  target for 'multi-model' tiers, and the automatic fallback when codex
   *  CLI's OAuth is down. null when ORVEX_DEEPSEEK_API_KEY is not set. */
  deepseekModel: LlmTarget | null;
  maxFileBytes: number;
  maxFiles: number;
  enableCheckRuns: boolean;
  store: AppDatabase;
}

type ModelTier = 'premium' | 'standard' | 'hybrid' | 'openai' | 'codex-hybrid' | 'multi-model' | 'dual-model';
export type PassTier = 'premium' | 'standard' | 'openai' | 'deepseek' | 'deepseek-flash';

/** The small outcome shape used to decide whether every required lens completed. */
export interface RequiredLensOutcome {
  modelPassIndex?: number;
  ok: boolean;
  /** Bonus/deep-extra passes never satisfy a required review lens. */
  bestEffort?: boolean;
}

/**
 * Return required lens ids that lack enough completed required samples. Deep
 * extras intentionally reuse a core model index, so their success must never
 * mask a failed core pass.
 */
export function failedRequiredLensIds(
  lensIds: readonly number[],
  outcomes: readonly RequiredLensOutcome[],
  requiredSuccesses: number,
): number[] {
  return lensIds.filter((lensId) => {
    const successes = outcomes.filter(
      (outcome) => outcome.modelPassIndex === lensId && outcome.ok && !outcome.bestEffort,
    ).length;
    return successes < requiredSuccesses;
  });
}

function premiumTarget(config: WorkerConfig): LlmTarget {
  return { apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl, model: config.llmModel, api: config.llmApi };
}

/** The model + cost-tier for a given review PASS.
 *  - 'codex-hybrid' → pass 1 (general) on CODEX (sharp), pass 2+ (deep-dive) on
 *    MiniMax (thorough breadth, and it reasons hard where codex's deep-dive skips).
 *  - 'multi-model'  → FOUR discovery passes for max blind-spot diversity:
 *    pass 1 Luna/Codex (general), pass 2 DeepSeek v4 Flash (deep-dive),
 *    pass 3 Flash again on removed-behavior/callers (Pro via ORVEX_PASS3_ON_DEEPSEEK_PRO),
 *    pass 4 MiniMax (perf/completeness). Pure API billing — no OAuth fragility.
 *  - 'dual-model' → TWO discovery passes: MiniMax (general) + DeepSeek v4 Flash
 *    (deep-dive). Flash also runs the end-of-review verify pass.
 *  - 'openai'   → the OpenAI reasoning model (gpt-5.x/Luna) on every pass.
 *  - 'hybrid'   → pass 1 (general) on MiniMax, pass 2+ (deep-dive) on GLM-5.2.
 *  - 'standard' → MiniMax on every pass.  'premium' → GLM on every pass. */
/**
 * Can this review run the AGENTIC path (codex CLI with a repo checkout) instead
 * of a one-shot API call? This is the ONLY place the question is answered.
 *
 * All three conditions are load-bearing:
 *  1. the feature flag is on;
 *  2. the plan designates an OpenAI-model pass 1 (other tiers were never
 *     designed for it, and shouldn't get CLI-routed by accident);
 *  3. the repo is ALLOWLISTED. codex runs with
 *     `--dangerously-bypass-approvals-and-sandbox` — a real shell as this OS
 *     user with filesystem and network access, against attacker-authored PR
 *     code. This is a security boundary, not a preference. Unset = no repo.
 */
export function canRunAgentic(plan: { modelTier?: ModelTier }, repoId: string): boolean {
  return (
    process.env.ORVEX_CODEX_CLI === '1' &&
    (plan.modelTier === 'codex-hybrid' || plan.modelTier === 'multi-model') &&
    isCodexRepoAllowed(repoId)
  );
}

/**
 * Sandboxed investigate tier (DeepSeek v4 Flash + read-only tools).
 *
 * On for multi-model (Verify*) plans when Codex CLI is NOT already providing an
 * agentic pass. Dual-model (free/Starter/Pro) stays at MiniMax + Flash discovery
 * + Flash verify only — no investigate, to keep the cheap two-model track.
 * Kill-switch: ORVEX_INVESTIGATE=0.
 */
export function canRunInvestigate(
  plan: { id?: string; modelTier?: ModelTier },
  opts: { useCodexCli: boolean },
): boolean {
  if (process.env.ORVEX_INVESTIGATE === '0') return false;
  if (opts.useCodexCli) return false; // Codex already explores the checkout
  return plan.modelTier === 'multi-model' || plan.modelTier === 'codex-hybrid';
}

/**
 * Investigate always prefers DeepSeek v4 Flash (cheap multi-hop reasoner).
 * Falls back to DeepSeek Pro, then OpenAI, then standard if Flash isn't configured.
 */
export function modelForInvestigate(
  config: WorkerConfig,
): { target: LlmTarget; tier: PassTier } {
  const override = (process.env.ORVEX_INVESTIGATE_TIER ?? 'deepseek-flash').trim().toLowerCase();
  if (override === 'openai' && config.openaiModel) {
    return { target: config.openaiModel, tier: 'openai' };
  }
  if (override === 'deepseek' && config.deepseekModel) {
    return { target: config.deepseekModel, tier: 'deepseek' };
  }
  if (override === 'standard') {
    return { target: config.standardModel, tier: 'standard' };
  }
  // Default + 'deepseek-flash': Flash first, then Pro, then OpenAI, then MiniMax.
  if (config.deepseekFlashModel) {
    return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
  }
  if (config.deepseekModel) return { target: config.deepseekModel, tier: 'deepseek' };
  if (config.openaiModel) return { target: config.openaiModel, tier: 'openai' };
  return { target: config.standardModel, tier: 'standard' };
}

export function modelForPass(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
  passIndex: number,
  /** Pass `canRunAgentic(...)`. `codexCliModel` is a STUB target (`apiKey: ''`,
   *  no baseUrl) usable ONLY through the CLI, which authenticates via
   *  CODEX_HOME. Selecting it when the CLI won't run sends pass 1 down the plain
   *  HTTP path with an empty key — it resolves to the Anthropic client, 401s,
   *  and since pass 1 is required the whole review aborts. Defaults to false so
   *  a caller that doesn't know can never trip that. */
  agentic = false,
): { target: LlmTarget; tier: PassTier } {
  if (plan.modelTier === 'codex-hybrid') {
    // general → codex (CLI if enabled, else paid API); deep-dive + further passes → MiniMax
    if (passIndex === 0 && config.codexCliModel && agentic) {
      return { target: config.codexCliModel, tier: 'openai' };
    }
    if (passIndex === 0 && config.openaiModel) return { target: config.openaiModel, tier: 'openai' };
    return { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'multi-model') {
    // pass 1 (general) → the frontier OpenAI model (Luna) — sharpest first look,
    // same "strongest model owns the broadest pass" pattern codex-hybrid used.
    // Prefer the CODEX CLI (API-key auth, not OAuth) when configured: same
    // model, but with real repo-exploration tool calls (rg/cat/git diff)
    // instead of a single-shot call — the repo-sweep capability, without any
    // OAuth session fragility since API keys don't expire/rotate/get revoked.
    if (passIndex === 0 && config.codexCliModel && agentic) {
      return { target: config.codexCliModel, tier: 'openai' };
    }
    if (passIndex === 0 && config.openaiModel) return { target: config.openaiModel, tier: 'openai' };
    // pass 2 (deep-dive) → DeepSeek v4 Flash (currently the stronger DeepSeek
    // for hunting subtle defects a first read misses).
    if (passIndex === 1 && config.deepseekFlashModel) {
      return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
    }
    if (passIndex === 1 && config.deepseekModel) return { target: config.deepseekModel, tier: 'deepseek' };
    // pass 3 (removed-behavior / caller audit) → Flash again by default (cheap
    // second angle on a DIFFERENT lens). Model diversity used to prefer Pro
    // here; set ORVEX_PASS3_ON_DEEPSEEK_PRO=1 to restore Pro as the independent
    // reasoner if ablation shows Flash-twice loses unique caller/removal bugs.
    if (passIndex === 2) {
      if (process.env.ORVEX_PASS3_ON_DEEPSEEK_PRO === '1' && config.deepseekModel) {
        return { target: config.deepseekModel, tier: 'deepseek' };
      }
      if (config.deepseekFlashModel) {
        return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
      }
      if (config.deepseekModel) return { target: config.deepseekModel, tier: 'deepseek' };
    }
    // pass 4 (perf/completeness breadth) + any missing-key fallback → MiniMax.
    return { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'dual-model') {
    // TWO-MODEL entry track: MiniMax general + DeepSeek v4 Flash deep-dive.
    // Flash (not Pro) keeps the paid/free entry stack cheap while still giving
    // a second independent reasoner. Falls back to Pro, then MiniMax, if Flash
    // isn't configured.
    if (passIndex === 1) {
      if (config.deepseekFlashModel) {
        return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
      }
      if (config.deepseekModel) return { target: config.deepseekModel, tier: 'deepseek' };
    }
    return { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'openai') {
    if (config.openaiModel) return { target: config.openaiModel, tier: 'openai' };
    // P3-4: missing OpenAI key must fall back to standard, not premium.
    return { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'hybrid') {
    return passIndex === 0
      ? { target: config.standardModel, tier: 'standard' }
      : { target: premiumTarget(config), tier: 'premium' };
  }
  if (plan.modelTier === 'standard') return { target: config.standardModel, tier: 'standard' };
  return { target: premiumTarget(config), tier: 'premium' };
}

/** The target and accounting tier for the single verification pass. */
export function modelForPlanWithTier(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
): { target: LlmTarget; tier: PassTier } {
  // VERIFICATION IS THE PRECISION GATE — it decides what the customer actually
  // sees. Prefer DeepSeek v4 Flash as challenger on every modern tier: cheap,
  // strong on premise checks, and independent of MiniMax discovery on dual-model
  // / of Luna discovery on multi-model. Escape hatches:
  //   ORVEX_VERIFY_ON_STANDARD=1 → MiniMax (legacy weak+rescue path)
  //   ORVEX_VERIFY_ON_OPENAI=1   → Luna (explicit only; not the default)
  //   ORVEX_VERIFY_ON_DEEPSEEK_PRO=1 → DeepSeek Pro instead of Flash
  if (
    plan.modelTier === 'multi-model'
    || plan.modelTier === 'codex-hybrid'
    || plan.modelTier === 'dual-model'
  ) {
    if (process.env.ORVEX_VERIFY_ON_STANDARD === '1') {
      return { target: config.standardModel, tier: 'standard' };
    }
    if (process.env.ORVEX_VERIFY_ON_OPENAI === '1' && config.openaiModel) {
      return { target: config.openaiModel, tier: 'openai' };
    }
    if (process.env.ORVEX_VERIFY_ON_DEEPSEEK_PRO === '1' && config.deepseekModel) {
      return { target: config.deepseekModel, tier: 'deepseek' };
    }
    if (config.deepseekFlashModel) {
      return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
    }
    if (config.deepseekModel) return { target: config.deepseekModel, tier: 'deepseek' };
    return { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'standard' || plan.modelTier === 'openai') {
    return { target: config.standardModel, tier: 'standard' };
  }
  return { target: premiumTarget(config), tier: 'premium' };
}

/** Backward-compatible target-only selection for callers that do not meter usage. */
export function modelForPlan(config: WorkerConfig, plan: { modelTier?: ModelTier }): LlmTarget {
  return modelForPlanWithTier(config, plan).target;
}

let sharedStore: AppDatabase | null = null;

export function loadWorkerConfig(): WorkerConfig {
  const github = loadGitHubConfigFromEnv();

  // MiniMax takes precedence when configured; Anthropic otherwise.
  const minimaxKey = process.env.MINIMAX_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!minimaxKey && !anthropicKey) {
    throw new Error('MINIMAX_API_KEY or ANTHROPIC_API_KEY is required');
  }

  if (!sharedStore) {
    sharedStore = createAppDatabase();
  }

  const premiumApiKey = (minimaxKey ?? anthropicKey)!;
  const premiumApi = minimaxKey
    ? process.env.MINIMAX_API === 'anthropic'
      ? 'anthropic'
      : process.env.MINIMAX_API === 'chat'
        ? 'chat'
        : process.env.MINIMAX_BASE_URL?.includes('/anthropic')
          ? 'anthropic'
          : 'chat'
    : undefined;
  const premiumBaseUrl = minimaxKey
    ? (process.env.MINIMAX_BASE_URL ?? (premiumApi === 'anthropic' ? 'https://api.minimax.io/anthropic' : 'https://api.minimax.io/v1'))
    : undefined;
  const premiumModel = minimaxKey
    ? (process.env.MINIMAX_MODEL ?? 'MiniMax-M3')
    : (process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514');

  // The cheaper 'standard' model (Review/Free). Configured via ORVEX_STANDARD_*;
  // if unset, falls back to the premium model so nothing breaks.
  const stdKey = process.env.ORVEX_STANDARD_API_KEY;
  const stdModelName = process.env.ORVEX_STANDARD_MODEL ?? 'MiniMax-M3';
  const stdApi = process.env.ORVEX_STANDARD_API === 'anthropic'
    ? 'anthropic'
    : process.env.ORVEX_STANDARD_API === 'responses'
      ? 'responses'
      : process.env.ORVEX_STANDARD_API === 'chat'
        ? 'chat'
        : process.env.ORVEX_STANDARD_BASE_URL?.includes('/anthropic')
          ? 'anthropic'
          : 'chat';
  const standardModel: LlmTarget = stdKey
    ? {
        apiKey: stdKey,
        baseUrl: process.env.ORVEX_STANDARD_BASE_URL ??
          (stdApi === 'anthropic' ? 'https://api.minimax.io/anthropic' : 'https://api.minimax.io/v1'),
        model: stdModelName,
        api: stdApi,
      }
    : { apiKey: premiumApiKey, baseUrl: premiumBaseUrl, model: premiumModel, api: premiumApi };

  // Optional OpenAI reasoning model via /v1/responses. Verify's first pass uses
  // this direct API target when configured; it can be enabled or changed without
  // a code deployment.
  const openaiKey = process.env.ORVEX_OPENAI_API_KEY;
  const openaiModel: LlmTarget | null = openaiKey
    ? {
        apiKey: openaiKey,
        baseUrl: process.env.ORVEX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: process.env.ORVEX_OPENAI_MODEL ?? 'gpt-5.6-luna',
        // 'responses' for OpenAI's native gpt-5.x endpoint; 'chat' for
        // OpenAI-compatible gateways (OpenRouter etc. — verified live: streams
        // and accepts reasoning_effort on /chat/completions).
        api: process.env.ORVEX_OPENAI_API === 'chat' ? 'chat' : 'responses',
        reasoningEffort: process.env.ORVEX_OPENAI_REASONING_EFFORT ?? 'xhigh',
      }
    : null;

  // Optional local Codex CLI (OAuth/login) used for codex-hybrid pass 1 instead
  // of the paid OpenAI API.
  const codexCliModel: LlmTarget | null =
    process.env.ORVEX_CODEX_CLI === '1'
      ? {
          apiKey: '',
          model: process.env.ORVEX_CODEX_CLI_MODEL?.trim() || DEFAULT_CODEX_CLI_MODEL,
          reasoningEffort: process.env.ORVEX_CODEX_CLI_REASONING_EFFORT?.trim() || DEFAULT_CODEX_CLI_REASONING_EFFORT,
        }
      : null;

  // Optional DeepSeek model — reasoning-heavy, cheap, no OAuth. Standalone pass
  // target for 'multi-model' tiers, and codex-hybrid's automatic pass-1
  // fallback when the CLI's OAuth session is down.
  const deepseekKey = process.env.ORVEX_DEEPSEEK_API_KEY;
  const deepseekModel: LlmTarget | null = deepseekKey
    ? {
        apiKey: deepseekKey,
        baseUrl: process.env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: process.env.ORVEX_DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
        reasoningEffort: process.env.ORVEX_DEEPSEEK_EFFORT ?? 'max',
      }
    : null;

  // DeepSeek v4 Flash rides the SAME API key as v4 Pro — only the model id
  // differs — so enabling it costs no new credential.
  const deepseekFlashModel: LlmTarget | null = deepseekKey
    ? {
        apiKey: deepseekKey,
        baseUrl: process.env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: process.env.ORVEX_DEEPSEEK_FLASH_MODEL ?? 'deepseek-v4-flash',
        reasoningEffort: process.env.ORVEX_DEEPSEEK_FLASH_EFFORT ?? 'max',
      }
    : null;

  return {
    github,
    llmApiKey: premiumApiKey,
    llmBaseUrl: premiumBaseUrl,
    llmModel: premiumModel,
    llmApi: premiumApi,
    standardModel,
    openaiModel,
    codexCliModel,
    deepseekModel,
    deepseekFlashModel,
    maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 300_000),
    maxFiles: Number(process.env.MAX_FILES ?? 150),
    enableCheckRuns: process.env.CHECK_RUNS_ENABLED === '1',
    store: sharedStore,
  };
}

export interface ProcessResult {
  findingCount: number;
  newCount: number;
  fixedCount: number;
  reviewId?: number;
  skipReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** severity/file/line of what this run NEWLY posted — deep-vs-normal scorecard */
  newFindings?: Array<{ severity: string; file: string; line?: number }>;
  /** `@orvex deep` only: did at least one of the EXTRA deep lenses actually
   *  complete? Deep bills 2x, and the extra lenses are best-effort — so when
   *  every one of them fails the customer paid double for a review that is
   *  byte-for-byte a standard one. Billing keys off this, not off the request. */
  deepLensesRan?: boolean;
}

// ——— LLM cost model (USD per 1M tokens), PER MODEL TIER ———
//
// Verified against published pricing 2026-08-01. Every rate is the STANDARD
// short-context, cache-MISS rate — the conservative choice, since we bill the
// full input at this rate and never discount for cache hits (see below).
//
//   tier            model             in      out     cached-in   long-context
//   premium         GLM-5.2           1.40    4.40    0.26        (3x peak surcharge 14-18 Beijing)
//   standard        MiniMax-M3        0.30    1.20    0.06        >512K in -> 0.60 / 2.40
//   openai          gpt-5.6-luna      0.20    1.20    0.02        >272K in -> 0.40 / 1.80
//   deepseek        deepseek-v4-pro   0.435   0.87    0.003625
//   deepseek-flash  deepseek-v4-flash 0.14    0.28    0.0028
//
// TWO KNOWN INACCURACIES, both of which make us OVER-report cost (safe direction):
//  1. Cache hits are billed here at the full input rate. Real hit rates are high
//     — a repeated 36k prefix measured 99.99% cached on Luna — and cached input
//     is 10% (Luna), 20% (MiniMax) or <1% (DeepSeek) of the miss rate. Providers
//     do report cached_tokens; wiring that through would sharpen this materially.
//  2. Long-context surcharges are NOT modelled. Review prompts run ~180k input,
//     under both thresholds, so this is currently inert — but an agentic codex
//     pass has been observed at 1.1M cumulative tokens, and any SINGLE call over
//     272k would bill Luna at 2x in / 1.5x out for the whole request.
// Every rate stays env-overridable so a price change needs no deploy.
const PREMIUM_COST_IN = Number(process.env.ORVEX_COST_INPUT_PER_M ?? 1.4);
const PREMIUM_COST_OUT = Number(process.env.ORVEX_COST_OUTPUT_PER_M ?? 4.4);
const STANDARD_COST_IN = Number(process.env.ORVEX_STANDARD_COST_INPUT_PER_M ?? 0.3);
const STANDARD_COST_OUT = Number(process.env.ORVEX_STANDARD_COST_OUTPUT_PER_M ?? 1.2);
// gpt-5.6-luna after the 2026-07-30 cut (was 1.00 / 6.00 — an 80% reduction).
const OPENAI_COST_IN = Number(process.env.ORVEX_OPENAI_COST_INPUT_PER_M ?? 0.2);
const OPENAI_COST_OUT = Number(process.env.ORVEX_OPENAI_COST_OUTPUT_PER_M ?? 1.2);
// deepseek-v4-pro. The previous 0.55 / 2.19 defaults were guesses and overstated
// OUTPUT by 2.5x — and output dominates a reasoning model's bill, so every
// DeepSeek pass was costed far too high.
const DEEPSEEK_COST_IN = Number(process.env.ORVEX_DEEPSEEK_COST_INPUT_PER_M ?? 0.435);
const DEEPSEEK_COST_OUT = Number(process.env.ORVEX_DEEPSEEK_COST_OUTPUT_PER_M ?? 0.87);
// deepseek-v4-flash — roughly a third of v4-pro on both sides.
const DEEPSEEK_FLASH_COST_IN = Number(process.env.ORVEX_DEEPSEEK_FLASH_COST_INPUT_PER_M ?? 0.14);
const DEEPSEEK_FLASH_COST_OUT = Number(process.env.ORVEX_DEEPSEEK_FLASH_COST_OUTPUT_PER_M ?? 0.28);
function computeCostUsd(inputTokens: number, outputTokens: number, tier: PassTier): number {
  const [inRate, outRate] =
    tier === 'standard'
      ? [STANDARD_COST_IN, STANDARD_COST_OUT]
      : tier === 'openai'
        ? [OPENAI_COST_IN, OPENAI_COST_OUT]
        : tier === 'deepseek'
          ? [DEEPSEEK_COST_IN, DEEPSEEK_COST_OUT]
          : tier === 'deepseek-flash'
            ? [DEEPSEEK_FLASH_COST_IN, DEEPSEEK_FLASH_COST_OUT]
            : [PREMIUM_COST_IN, PREMIUM_COST_OUT];
  return (inputTokens / 1e6) * inRate + (outputTokens / 1e6) * outRate;
}

type TierUsage = {
  standard: { in: number; out: number };
  premium: { in: number; out: number };
  openai: { in: number; out: number };
  deepseek: { in: number; out: number };
  'deepseek-flash': { in: number; out: number };
};

/** Total tokens + cost from per-tier usage (a review can mix models, each with
 *  its own $/token). */
function totalUsage(usage: TierUsage): { inputTokens: number; outputTokens: number; costUsd: number } {
  // ITERATE the tiers rather than summing them by hand. The hand-written
  // version silently omitted any newly-added tier — adding 'deepseek-flash'
  // would have under-reported its cost with no type error, which is the same
  // class of defect as the 5x Luna mispricing.
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const [tier, u] of Object.entries(usage) as Array<[PassTier, { in: number; out: number }]>) {
    inputTokens += u.in;
    outputTokens += u.out;
    costUsd += computeCostUsd(u.in, u.out, tier);
  }
  return { inputTokens, outputTokens, costUsd };
}

/** Run async tasks with a bounded concurrency limit, preserving input order.
 *  Used to fan out review passes + sweep batches so a deep Verify review runs in
 *  parallel instead of sequentially — same coverage, a fraction of the wall time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const MS_PER_30_DAYS = 30 * 24 * 3_600_000;

/**
 * Which account limit (if any) this GitHub account has hit. Callers that reserve
 * a slot must invoke this inside `store.tryReserveReviewRun` (BEGIN IMMEDIATE)
 * so multi-worker processes cannot both pass the count and both insert.
 * Counts running + completed + failed reviews so in-flight reviews see each
 * other and post-spend failures cannot refund a credit.
 * Checked cheapest/most-specific first: free-trial lifetime cap (when set),
 * then hourly burst, then monthly hard cap. Metered plans skip the hard monthly.
 */
const GLOBAL_FREE_TIER_DAILY_CAP = Number(process.env.ORVEX_FREE_TIER_DAILY_CAP ?? 300);

export function accountLimitReason(
  store: WorkerConfig['store'],
  owner: string,
  plan: ReturnType<typeof planFeatures>,
): 'rate_limited' | 'monthly_limit' | 'trial_exhausted' | 'free_tier_capped' | null {
  // GLOBAL free-tier circuit-breaker: a hard ceiling on total free reviews per
  // rolling 24h across ALL accounts. This is the abuse BACKSTOP — it bounds the
  // dollar damage of trial-farming no matter how a farmer evades the per-account
  // (10/owner) and per-IP (5 accounts/IP/day) gates. Trips well above any real
  // free-tier day; when it fires, ops gets a loud log and can raise it.
  if (plan.trialReviewLimit !== null) {
    const globalToday = store.countGlobalFreeTierReviewsSince(3_600_000 * 24);
    if (globalToday >= GLOBAL_FREE_TIER_DAILY_CAP) {
      console.error(
        `[abuse] FREE-TIER DAILY CAP HIT: ${globalToday} free reviews in 24h (cap ${GLOBAL_FREE_TIER_DAILY_CAP}). Pausing free reviews — likely trial-farming. Raise ORVEX_FREE_TIER_DAILY_CAP if this is genuine growth.`,
      );
      return 'free_tier_capped';
    }
  }
  // Prefer trial_exhausted over hourly when the lifetime trial is spent — otherwise a
  // free account at 10/10 with 2/2 hourly gets "wait ~Xh" instead of "upgrade".
  if (plan.trialReviewLimit !== null && store.countAccountReviews(owner) >= plan.trialReviewLimit) {
    return 'trial_exhausted';
  }
  if (
    plan.reviewsPerHour !== null &&
    store.countAccountReviews(owner, { sinceMs: 3_600_000 }) >= plan.reviewsPerHour
  ) {
    return 'rate_limited';
  }
  if (
    plan.reviewsPerMonth !== null &&
    plan.overageCentsPerReview === null &&
    store.countAccountReviews(owner, { sinceMs: MS_PER_30_DAYS }) >= plan.reviewsPerMonth
  ) {
    return 'monthly_limit';
  }
  return null;
}

export function providerConfigurationIssue(
  plan: ReturnType<typeof planFeatures>,
  config: WorkerConfig,
): string | null {
  const needsIndependentReviewer = plan.modelTier === 'dual-model' || plan.modelTier === 'multi-model';
  if (needsIndependentReviewer && !config.deepseekModel && !config.deepseekFlashModel) {
    return 'The independent review provider is not configured. This review was not run; contact support to restore provider capacity.';
  }
  if (plan.modelTier === 'multi-model' && !config.openaiModel && !config.codexCliModel) {
    return 'The frontier review provider is not configured for this plan. This review was not run; contact support to restore provider capacity.';
  }
  return null;
}


const LIMIT_NUDGE_COOLDOWN_MS = 30 * 60_000;

/** Post a clear quota nudge when a review is blocked (best-effort, deduped per PR). */
async function postLimitNudge(
  config: WorkerConfig,
  job: ReviewJobPayload,
  plan: ReturnType<typeof planFeatures>,
  reason: 'rate_limited' | 'monthly_limit' | 'trial_exhausted',
): Promise<void> {
  // Skip if we already recorded (and nudged for) this reason on this PR recently.
  // Count includes the skip row just written by the caller — >1 means a prior skip.
  const recent = config.store.countRecentSkippedRuns(
    {
      installationId: job.installationId,
      owner: job.owner,
      repo: job.repo,
      pr: job.pr,
    },
    reason,
    LIMIT_NUDGE_COOLDOWN_MS,
  );
  if (recent > 1) {
    console.log(`[worker] ${reason} ${job.owner} (plan=${plan.id}) — nudge suppressed (cooldown)`);
    return;
  }
  const status = loadAccountQuotaStatus(config.store, job.owner, job.tenantId, plan);
  const body = formatLimitBlockedComment(status, reason, commandTrigger());
  try {
    const octokit = createInstallationOctokit(config.github, job.installationId);
    await octokit.rest.issues.createComment({ owner: job.owner, repo: job.repo, issue_number: job.pr, body });
    console.log(`[worker] ${reason} ${job.owner} (plan=${plan.id})`);
  } catch {
    /* nudge is best-effort */
  }
}

/** Tell the PR owner when no trustworthy verdict was produced. */
async function postReviewFailureNotice(
  config: WorkerConfig,
  job: ReviewJobPayload,
  error: string,
): Promise<void> {
  const transient = isTransientLlmError(error);
  const marker = `<!-- orvex-review-failure:${job.installationId}:${job.owner}/${job.repo}#${job.pr}@${job.headSha} -->`;
  const body = [
    marker,
    '⚠️ **Orvex could not complete this review.**',
    '',
    transient
      ? 'A review provider was temporarily unavailable or rate-limited. Orvex will retry automatically when possible.'
      : 'No clean-review verdict was produced because the review pipeline failed before it could complete.',
    '',
    'Please push a new commit or comment `@orvex review` to try again. If this keeps happening, contact support@useorvex.com.',
  ].join('\n');
  try {
    const octokit = createInstallationOctokit(config.github, job.installationId);
    await octokit.rest.issues.createComment({
      owner: job.owner,
      repo: job.repo,
      issue_number: job.pr,
      body,
    });
  } catch (noticeError) {
    console.warn('[worker] review failure notice could not be posted:', (noticeError as Error).message);
  }
}

export async function processReviewJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const runBase = {
    tenantId: job.tenantId,
    installationId: job.installationId,
    owner: job.owner,
    repo: job.repo,
    pr: job.pr,
    headSha: job.headSha,
    action: job.action,
  };

  // Cooldown on COMMAND/MANUAL re-review of an unchanged commit — `@orvex review`
  // or a manual API call bypasses the automatic SHA dedup BY DESIGN (so a human
  // can force a fresh look), but with no floor at all, the same expensive review
  // can be re-run back-to-back indefinitely. A new push always gets a new SHA and
  // is completely unaffected by this; only re-running an ALREADY-completed review
  // of the SAME commit is throttled.
  if (job.action === 'command' || job.action === 'manual') {
    const cooldownS = Number(process.env.ORVEX_REVIEW_COOLDOWN_S ?? 120);
    const sinceS = config.store.secondsSinceLastCompletedReview(
      job.installationId,
      job.owner,
      job.repo,
      job.pr,
      job.headSha,
    );
    if (sinceS !== null && sinceS < cooldownS) {
      const waitS = cooldownS - sinceS;
      config.store.recordReviewRun({ ...runBase, status: 'skipped', skipReason: 'review_cooldown', durationMs: 0 });
      try {
        const octokit = createInstallationOctokit(config.github, job.installationId);
        await octokit.rest.issues.createComment({
          owner: job.owner,
          repo: job.repo,
          issue_number: job.pr,
          body: `⏳ This commit was already reviewed ${sinceS}s ago — re-running now would just repeat it. Try again in ~${waitS}s, or push a new commit for a fresh review.`,
        });
      } catch {
        /* best-effort */
      }
      console.log(`[worker] cooldown: ${job.owner}/${job.repo}#${job.pr}@${job.headSha.slice(0, 7)} reviewed ${sinceS}s ago (<${cooldownS}s)`);
      return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'review_cooldown' };
    }
  }

  // Free-tier / hourly limits: check + reserve `running` in one BEGIN IMMEDIATE
  // transaction so multi-worker processes sharing SQLite cannot both slip past.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  const isFreeTier = plan.trialReviewLimit !== null;
  const providerIssue = providerConfigurationIssue(plan, config);
  if (providerIssue) {
    config.store.recordReviewRun({
      ...runBase,
      status: 'skipped',
      skipReason: 'provider_not_configured',
      durationMs: Date.now() - startedAt,
    });
    if (
      config.store.countRecentSkippedRuns(
        { installationId: job.installationId, owner: job.owner, repo: job.repo, pr: job.pr },
        'provider_not_configured',
        LIMIT_NUDGE_COOLDOWN_MS,
      ) === 1
    ) {
      await postReviewFailureNotice(config, job, providerIssue);
    }
    return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'provider_not_configured' };
  }
  const resumed = job.runId ? config.store.resumeReviewRun(job.runId, runBase) : 'unavailable';
  if (resumed === 'completed') {
    return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'already_completed_after_restart' };
  }

  let runId: string;
  if (resumed === 'resumed') {
    runId = job.runId!;
  } else {
    const reserved = config.store.tryReserveReviewRun(
      { ...runBase, deep: Boolean(job.deep), freeTier: isFreeTier },
      () =>
        isFreeTier || plan.reviewsPerHour !== null
          ? accountLimitReason(config.store, job.owner, plan)
          : null,
    );
    if (!reserved.ok) {
      // The global cap is an anti-abuse pause, not a per-user limit — don't nudge
      // the (possibly innocent) author to upgrade; just skip quietly.
      if (reserved.reason !== 'free_tier_capped') {
        await postLimitNudge(
          config,
          job,
          plan,
          reserved.reason as 'rate_limited' | 'monthly_limit' | 'trial_exhausted',
        );
      }
      return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: reserved.reason };
    }
    runId = reserved.runId;
  }
  // Preserve the row id if shutdown has to requeue this exact in-flight job.
  job.runId = runId;

  try {
    const result = await executeReview(job, config, runId);
    const consumedProviderBudget =
      Boolean(result.skipReason) &&
      Boolean((result.inputTokens ?? 0) > 0 || (result.outputTokens ?? 0) > 0 || (result.costUsd ?? 0) > 0);
    config.store.completeReviewRun(runId, {
      status: result.skipReason && !consumedProviderBudget ? 'skipped' : result.skipReason ? 'failed' : 'completed',
      skipReason: result.skipReason,
      error: consumedProviderBudget ? `review did not complete: ${result.skipReason}` : undefined,
      durationMs: Date.now() - startedAt,
      findingsNew: result.newCount,
      findingsFixed: result.fixedCount,
      findingsOpen: result.findingCount,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      newFindings: result.newFindings,
      // Correct the row's `deep` flag to what was actually DELIVERED — the
      // scorecard and completedReviewUnitsSince both read this column.
      deep: Boolean(job.deep) && result.deepLensesRan === true,
    });
    // Metered-overage plans (have an included quota + per-review overage price).
    // 'review-plus' (unlimited) and 'enterprise'/'free' are excluded — no overage.
    if (!result.skipReason && (plan.id === 'review' || plan.id === 'verify-lite' || plan.id === 'verify')) {
      try {
        // Charge the 2x deep rate ONLY if an extra deep lens actually completed.
        // They are best-effort, so an all-failed deep run delivers a standard
        // review — billing double for that is charging for undelivered work.
        const billedDeep = Boolean(job.deep) && result.deepLensesRan === true;
        if (job.deep && !billedDeep) {
          console.warn(`[billing] run ${runId}: deep requested but no extra lens completed — billing at standard rate`);
        }
        await reportStripeReviewOverage({ store: config.store, tenantId: job.tenantId, plan: plan.id, runId, deep: billedDeep });
      } catch (err) {
        console.error(`[billing] failed to report Stripe overage for run ${runId}:`, err);
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    config.store.completeReviewRun(runId, {
      status: 'failed',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    if (
      config.store.countRecentFailedRuns({
        installationId: job.installationId,
        owner: job.owner,
        repo: job.repo,
        pr: job.pr,
      }) === 1
    ) {
      await postReviewFailureNotice(config, job, message);
    }
    throw err;
  }
}

async function executeReview(
  job: ReviewJobPayload,
  config: WorkerConfig,
  /** the 'running' row created by processReviewJob — re-pointed at the real head SHA below */
  runId?: string,
): Promise<ProcessResult> {
  const { installationId, tenantId, owner, repo, pr: number, action } = job;
  const ref = { owner, repo, number };

  if (config.github.allowedRepo && !isRepoAllowed(owner, repo, config.github.allowedRepo)) {
    throw new Error(`Repo ${owner}/${repo} not in GITHUB_ALLOWED_REPO allowlist`);
  }

  const installation = config.store.getInstallation(installationId);
  if (!installation || installation.suspendedAt) {
    throw new Error(`Installation ${installationId} not active`);
  }

  // The tenant's plan drives review DEPTH and which features run — this is the
  // enforced separation between tiers (Free/Review/Verify), not just wording.
  const plan = planFeatures(config.store.getTenantPlan(tenantId));
  // The review passes use modelForPass (may be codex on the Verify test); the
  // single verification pass uses a plan-aware target; retain its cost tier so
  // usage accounting follows the model that actually received the request.
  const verificationTarget = modelForPlanWithTier(config, plan);
  const llm = verificationTarget.target;
  const verificationTier = verificationTarget.tier;
  const reviewModel = modelForPass(config, plan, 0).target.model;
  console.log(`[worker] plan=${plan.id} review=${reviewModel} verify=${llm.model}`);

  console.log(
    `[worker] tenant=${tenantId.slice(0, 8)} inst=${installationId} account=${installation.accountLogin} plan=${plan.id}`,
  );

  const octokit = createInstallationOctokit(config.github, installationId);
  // (Free-tier trial/hourly limits are enforced up front in processReviewJob,
  // before this review is even recorded, so they reserve the slot atomically.)

  const pr = await fetchPullRequest(octokit, ref);
  const effectiveSha = pr.headSha;
  // The run row was created from the webhook payload's headSha, which can be
  // STALE (a newer commit landed between event and execution). Record the run
  // on the SHA actually being reviewed — cooldown, dedup, and the scorecard
  // all key on head_sha.
  if (runId && effectiveSha !== job.headSha) {
    console.log(`[worker] head moved ${job.headSha.slice(0, 7)} → ${effectiveSha.slice(0, 7)} since enqueue; recording run on effective SHA`);
    config.store.setReviewRunHeadSha(runId, effectiveSha);
  }

  const labels = await fetchPrLabels(octokit, ref);
  // This config file is optional — a transient GitHub 5xx/network blip on the
  // lookup must fall back to defaults, not abort the whole review (it did:
  // PR93 died in 8s on a raw 502 here, before any LLM call ran).
  let repoConfigYaml: string | null = null;
  try {
    // READ THE CONFIG FROM THE BASE REF, NOT THE PR HEAD. The head is
    // attacker-controlled on any fork PR, and this config overrides workspace
    // settings outright — so a PR that added `.orvex-review.yml` with
    // `ignore: ["**"]` produced a deterministic "no issues found, looks good to
    // merge" on itself, with no model involved. The base ref is what the repo's
    // maintainers actually approved.
    const configRef = pr.baseSha || effectiveSha;
    repoConfigYaml =
      (await fetchRepoFile(octokit, owner, repo, '.orvex-review.yml', configRef)) ??
      // deprecated pre-rename config filename; remove after customers migrate
      (await fetchRepoFile(octokit, owner, repo, '.velatrix-review.yml', configRef));
  } catch (err) {
    console.error(`[worker] repo config fetch failed, using defaults: ${(err as Error).message}`);
  }
  const reviewConfig = effectiveReviewConfig(
    repoConfigYaml,
    config.store.getWorkspaceSettings(tenantId),
    config.store.getRepoByFullName(installationId, `${owner}/${repo}`)?.reviewMode,
  );

  if (hasIgnoreLabel(labels, reviewConfig.ignore_labels)) {
    console.log(`[worker] skip PR #${number}: label ${reviewConfig.ignore_labels.join('/')}`);
    return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'ignore_label' };
  }

  // A manual review (`@orvex review` → action 'command', or the API → 'manual')
  // is an explicit request, so it reviews even a draft PR. Auto triggers
  // (opened/synchronize/reopened) still skip drafts.
  const isManualTrigger = action === 'command' || action === 'manual';
  const skipReason = shouldSkipPr(pr, {
    botLogin: config.github.botLogin,
    allowDraft: isManualTrigger,
  });
  if (skipReason) {
    console.log(`[worker] skip PR #${number}: ${skipReason}`);
    return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason };
  }

  const priorState = config.store.getState({ installationId, owner, repo, pr: number });
  // Codex CLI session id for this PR — re-used across re-reviews so the model
  // keeps the same conversation context; undefined starts a fresh session.
  let codexThreadId = priorState?.codexThreadId;
  const sinceSha =
    action === 'synchronize' && priorState?.lastSha ? priorState.lastSha : undefined;

  const { files, coverage } = await fetchPrDiffWithCoverage(octokit, ref, {
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles,
    ignoreGlobs: reviewConfig.ignore,
    sinceSha,
    headSha: effectiveSha,
  });
  if (!coverage.complete) {
    console.warn(
      `[worker] PARTIAL coverage ${owner}/${repo}#${number}: ${coverage.reviewed}/${coverage.candidates} files reviewed, ${coverage.skippedByCap} over cap, ${coverage.truncatedFiles} truncated, ${coverage.omittedPatch} patch-omitted`,
    );
  }

  console.log(
    `[worker] PR #${number} @ ${effectiveSha.slice(0, 7)} action=${action} files=${files.length}` +
      (sinceSha ? ` incremental ${sinceSha.slice(0, 7)}..${effectiveSha.slice(0, 7)}` : ' full diff'),
  );

  const fileReader = {
    readFile: (path: string, ref: string) =>
      fetchFileContent(octokit, owner, repo, path, ref),
  };

  const priorOpen = (priorState?.findings ?? []).filter((f) => f.status === 'open');
  const {
    stillOpen: verifiedOpen,
    newlyFixed: verifiedFixed,
    readErrorFps,
  } = await reconcileFixedOnHead(priorOpen, effectiveSha, fileReader);

  for (const fixed of verifiedFixed) {
    if (fixed.githubCommentId) {
      try {
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          number,
          fixed.githubCommentId,
          formatFixedReply(effectiveSha),
        );
      } catch (err) {
        console.warn(`[worker] could not reply on comment ${fixed.githubCommentId}:`, err);
      }
    }
  }

  const ruleFindings = await runDeterministicRules(
    octokit,
    owner,
    repo,
    effectiveSha,
    files,
    reviewConfig,
  );

  const filesForLlm = files.filter((f) => {
    // Every changed file with a patch gets the deep LLM review. (Previously a
    // file was SKIPPED once semgrep flagged it — that silently dropped LLM
    // review on exactly the files most likely to have deeper bugs. Semgrep
    // findings are additive, not a replacement for the model's review.)
    return Boolean(f.patch) && f.status !== 'removed';
  });
  // Investigate also needs fully-deleted file patches (dangling-caller seeds).
  const filesForInvestigate = files.filter((f) => Boolean(f.patch));

  let llmSummary: string | undefined;
  // Best-effort passes that failed — surfaced in the posted review so a partial
  // run can never read as a full sign-off.
  let skippedLenses: string[] = [];
  // Only true once an extra deep lens has actually produced a review.
  let deepLensesRan = false;
  let llmFindings: ReviewFinding[] = [];
  let aggregationManualCandidates: ReviewSurfaceFinding[] = [];
  // Token usage per model tier — a hybrid review runs two different models, so
  // cost is tracked separately (each has its own $/token) and summed.
  const usage: TierUsage = {
    standard: { in: 0, out: 0 },
    premium: { in: 0, out: 0 },
    openai: { in: 0, out: 0 },
    deepseek: { in: 0, out: 0 },
    'deepseek-flash': { in: 0, out: 0 },
  };
  const onUsageFor = (tier: PassTier) => (u: { inputTokens: number; outputTokens: number }) => {
    usage[tier].in += u.inputTokens;
    usage[tier].out += u.outputTokens;
  };
  // full-file contents used by both the review call and the verification pass
  let reviewContextFiles: Array<{ path: string; content: string }> = [];
  // repo tree paths, hoisted so the (later) deepVerify pass can locate manifests
  let repoTreePaths: string[] = [];

  if (filesForLlm.length > 0) {
    // Deep context: repo tree + files the changed code imports, so the model
    // can reason across files instead of judging hunks blind. ORVEX_DEEP_CONTEXT=0 disables.
    let reviewContext: Awaited<ReturnType<typeof buildRepoContext>> | undefined;
    if (process.env.ORVEX_DEEP_CONTEXT !== '0') {
      try {
        reviewContext = await buildRepoContext(
          octokit,
          owner,
          repo,
          effectiveSha,
          filesForLlm.map((f) => f.filename),
          // Deep context: every changed file in full + the import/dependency
          // neighborhood (the high-value cross-file signal), plus a modest slice
          // of the rest of the repo. All env-tunable — raising ORVEX_CTX_OTHERS
          // toward "whole repo" trades latency/cost for coverage (200 files ≈
          // an 11-minute review with reasoning on, which does not scale across
          // tenants), so the default keeps reviews to a few minutes.
          {
            maxSourceFiles: Number(process.env.ORVEX_CTX_SOURCE ?? 200),
            maxRelated: Number(process.env.ORVEX_CTX_RELATED ?? 18),
            maxDependents: Number(process.env.ORVEX_CTX_DEPENDENTS ?? 12),
            // Per-file cap raised so LARGE changed files are shown in FULL — a
            // bug past the old 32k cutoff (e.g. line 1600+ of a big file) was
            // invisible to the model. GLM-5.2's 1M window has room.
            maxFileBytes: Number(process.env.ORVEX_CTX_FILE_BYTES ?? 250_000),
            // Pull in enough of the rest of the repo to feed the whole-repo
            // sweep below (it batches these files); ORVEX_REPO_SWEEP_MAX_FILES
            // controls how deep the sweep goes.
            // Plan-driven: retrieve top-K relevant files for the passes (all
            // tiers), plus extra files only for the Verify whole-repo sweep.
            maxOthers: plan.retrievalTopK + (plan.repoSweep ? plan.sweepMaxFiles : 0),
          },
        );
        console.log(
          `[worker] deep context: ${reviewContext.changedContents.length} full files, ` +
            `${reviewContext.related.length} imports, ${reviewContext.dependents.length} dependents, ` +
            `${reviewContext.others.length} index-retrieved relevant files, tree=${reviewContext.treePaths.length}`,
        );
        reviewContextFiles = [
          ...reviewContext.changedContents,
          ...reviewContext.related,
          ...reviewContext.dependents,
          ...reviewContext.others,
        ];
        repoTreePaths = reviewContext.treePaths ?? [];
      } catch (err) {
        console.warn('[worker] deep context unavailable, reviewing diff-only:', err);
      }
    }

    // Depth is enforced HERE, in the harness, and scaled BY PLAN — not left to
    // how long one model call decides to think. Higher tiers get more passes and
    // (Verify only) an exhaustive whole-repo sweep. Findings accumulate and
    // dedupe by fingerprint; a hard call-count cap prevents runaway.
    // Reviewers and verifier receive diff and code context only — PR title/body
    // are a prompt-injection channel and reach no model prompt anywhere.
    const baseCtx: ReviewPromptContext = { ...(reviewContext ?? {}) };
    const runReview = (ctx: typeof baseCtx, target: LlmTarget, tier: PassTier, temperature?: number) =>
      runLlmReview(filesForLlm, {
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        model: target.model,
        api: target.api,
        reasoningEffort: target.reasoningEffort,
        temperature,
        context: ctx,
        onUsage: onUsageFor(tier),
      });

    const passes = Math.max(1, plan.reviewPasses);
    // Tuned so a Verify review is a genuinely deep ~10 minutes (not a 3-minute
    // burst that's indistinguishable from the base tier): more calls, deeper
    // per-file sweep reads (below), and MODERATE concurrency so the work spreads
    // out rather than finishing all at once. Review has few calls, so a lower
    // concurrency barely affects it — this mainly paces the many-call Verify tier.
    const configuredMaxCalls = Number(process.env.ORVEX_REVIEW_MAX_CALLS ?? 28);
    const maxCalls = Number.isFinite(configuredMaxCalls)
      ? Math.max(passes, Math.floor(configuredMaxCalls))
      : Math.max(passes, 28);
    const configuredConcurrency = Number(process.env.ORVEX_REVIEW_CONCURRENCY ?? 3);
    const concurrency = Number.isFinite(configuredConcurrency)
      ? Math.max(1, Math.floor(configuredConcurrency))
      : 3;
    const accumulated: ReviewFinding[] = [];

    // Build the full list of review calls up front — N passes over the change +
    // its neighborhood + top-K index files, plus (Verify only) whole-repo sweep
    // batches over the rest — then run them all with BOUNDED CONCURRENCY. Same
    // coverage as before, but parallel instead of sequential, so a deep review
    // finishes in a fraction of the wall-clock.
    const passOthers = (reviewContext?.others ?? []).slice(0, plan.retrievalTopK);
    const passCtx = { ...baseCtx, others: passOthers };

    // Each pass beyond the first uses a DIFFERENT lens — not a redundant re-run.
    // Pass 1 reviews generally; pass 2 deep-dives the subtle high-impact bugs; the
    // (Verify-only) pass 3 hunts an entirely SEPARATE class the bug-focused passes
    // skip — performance, completeness/what's-missing, and API/contract breakage.
    // Distinct focus is what makes extra passes catch meaningfully more.
    // Per-pass lens; pass index beyond the list reuses the last (deepest) angle.
    // Lens sequence, chosen by TIER rather than index-clamped.
    //
    // Relying on the clamp broke the 3-pass tiers: inserting the 4th lens in the
    // middle silently pushed the breadth lens off the end, so free/review lost
    // it entirely AND lost their only best-effort pass (a MiniMax timeout there
    // would then abort the whole review instead of degrading). The breadth lens
    // must stay LAST for every tier, so it is appended, not positioned.
    const FOURTH_LENS_TIERS = new Set<ModelTier>(['multi-model', 'codex-hybrid']);
    const BREADTH_ANGLE = {
      tag: 'perf/completeness/api',
      focus: THIRD_ANGLE_FOCUS,
      // Commonly MiniMax, whose reasoning can exceed the wall-clock cap on large
      // PRs. Declared here (not derived from the tag string) so a rename cannot
      // silently change which passes are required.
      bestEffort: true,
    };
    const PASS_ANGLES: Array<{ tag: string; focus?: string; bestEffort?: boolean }> = [
      { tag: 'general' },
      { tag: 'deep-dive', focus: DEEP_DIVE_FOCUS },
      // Only multi-model/codex-hybrid get a second independent DeepSeek reasoner
      // for this lens. Dual-model is intentionally two passes (MiniMax + Flash).
      ...(FOURTH_LENS_TIERS.has(plan.modelTier as ModelTier)
        ? [{ tag: 'removed-behavior/callers', focus: REMOVED_BEHAVIOR_FOCUS }]
        : []),
      BREADTH_ANGLE,
    ];

    type ReviewCall = {
      label: string;
      /** WHAT this call is. 'pass' = a named review lens that the abort gate
       *  cares about; 'sweep' = a breadth batch over extra repo files. */
      kind: 'pass' | 'sweep';
      /** HOW it executes — orthogonal to `kind`. 'agentic' runs the codex CLI
       *  with a real repo checkout and shell tools; 'investigate' is the
       *  sandboxed DeepSeek Flash tool loop (list/read/grep only); 'api' is a
       *  single-shot HTTPS call. */
      mode: 'agentic' | 'investigate' | 'api';
      ctx: typeof baseCtx;
      target: LlmTarget;
      tier: PassTier;
      /** Lens tag for contribution reporting (general / deep-dive / …). */
      passTag?: string;
      /** Zero-based repeated-review sample. Sweeps are always sample zero. */
      sample: number;
      /** Original model pass index, used to reselect an API target for repeated samples. */
      modelPassIndex?: number;
      /** Explicit low temperature used only by repeated API samples. */
      temperature?: number;
      // Best-effort passes (the perf/completeness breadth lens, the optional
      // `deep` extra lenses) enrich the review but must NEVER discard it: if one
      // times out or errors, the review still posts from the passes that
      // completed. The core general + deep-dive reasoners remain required.
      bestEffort?: boolean;
    };
    const tagFindings = (got: ReviewFinding[], tier: PassTier, passTag?: string) => {
      for (const f of got) {
        f.sourceTier = tier;
        if (passTag) f.sourcePass = passTag;
      }
    };
    // ONE answer to "does this review run agentically?", used by every site
    // below. Previously this decision was re-derived in five places with subtly
    // different conditions, which is how the pass-1 routing bug got in.
    const useCodexCli = canRunAgentic(plan, `${owner}/${repo}`);
    const wantInvestigate = canRunInvestigate(plan, { useCodexCli });
    const investigateModel = wantInvestigate ? modelForInvestigate(config) : null;
    // Read-only checkout for Codex and/or the sandboxed investigate tier.
    // Cleanup is guaranteed via the outer finally below — even if call-list
    // construction throws before the LLM run loop.
    const agentRepoDir =
      useCodexCli || wantInvestigate
        ? await checkoutRepoForAgent(octokit, owner, repo, effectiveSha)
        : null;
    try {
    const codexRepoDir = useCodexCli ? agentRepoDir : null;
    if (codexRepoDir) {
      console.log(`[worker] codex repo sweep: checked out ${owner}/${repo}@${effectiveSha.slice(0, 7)}`);
    } else if (wantInvestigate && agentRepoDir) {
      console.log(`[worker] investigate checkout: ${owner}/${repo}@${effectiveSha.slice(0, 7)}`);
    } else if (wantInvestigate && !agentRepoDir) {
      console.warn('[worker] investigate skipped: repo checkout unavailable');
      skippedLenses.push('investigate (repository checkout unavailable)');
    }
    if (wantInvestigate && !investigateModel) {
      skippedLenses.push('investigate (provider unavailable)');
    }
    // `@orvex deep` (paid plans): two EXTRA lenses beyond the standard three,
    // unioned into the same review — deliberately different angles, not reruns.
    const DEEP_EXTRA_ANGLES: Array<{ tag: string; focus: string; modelIdx: number }> = job.deep
      ? [
          {
            tag: 'deep:removed-behavior',
            modelIdx: 1, // the heavy reasoner (DeepSeek on dual/multi tiers)
            focus:
              'EXTRA DEEP-REVIEW PASS — REMOVED-BEHAVIOR & CALLER AUDIT. For every line this diff DELETES or replaces: name the invariant/behavior it enforced, then verify where the new code re-establishes it — a dropped guard, narrowed validation, or deleted error path that is NOT re-established is a finding. Then trace every changed function to its CALLERS: does any call site break on a new precondition, changed return shape, new exception, or ordering change? Report only concrete breakages with file:line.',
          },
          {
            tag: 'deep:second-opinion',
            modelIdx: 0,
            focus:
              'EXTRA DEEP-REVIEW PASS — ADVERSARIAL SECOND OPINION. Assume earlier review passes MISSED at least one real defect. Do not repeat the obvious; hunt specifically where reviews go blind: async boundaries and unawaited promises, error/cleanup paths, resource lifecycle (open/close/retry), identity scoping (tenant/user leaking across a boundary), and off-by-one/boundary conditions in new loops or slices. Report only findings with a concrete failure scenario.',
          },
        ]
      : [];
    const totalPasses = passes + DEEP_EXTRA_ANGLES.length;
    if (job.deep) console.log(`[worker] deep review requested: +${DEEP_EXTRA_ANGLES.length} extra passes`);

    const reviewCalls: ReviewCall[] = [];
    for (let p = 0; p < passes; p++) {
      const { target, tier } = modelForPass(config, plan, p, useCodexCli);
      const angle = PASS_ANGLES[Math.min(p, PASS_ANGLES.length - 1)];
      reviewCalls.push({
        label: `pass ${p + 1}/${totalPasses} (${angle.tag}) [${target.model}]`,
        kind: 'pass',
        mode: useCodexCli && tier === 'openai' ? 'agentic' : 'api',
        ctx: angle.focus ? { ...passCtx, extraFocus: angle.focus } : passCtx,
        target,
        tier,
        passTag: angle.tag,
        sample: 0,
        modelPassIndex: p,
        bestEffort: angle.bestEffort === true,
      });
    }
    for (const [i, extra] of DEEP_EXTRA_ANGLES.entries()) {
      // deep extras always take the plain API path, so codex is never routable here
      const { target, tier } = modelForPass(config, plan, extra.modelIdx, false);
      reviewCalls.push({
        label: `pass ${passes + i + 1}/${totalPasses} (${extra.tag}) [${target.model}]`,
        kind: 'pass',
        mode: 'api',
        ctx: { ...passCtx, extraFocus: extra.focus },
        target,
        tier,
        passTag: extra.tag,
        sample: 0,
        modelPassIndex: extra.modelIdx,
        bestEffort: true, // `deep` extras are bonus lenses — never abort the review
      });
    }

    // Sandboxed investigate: one best-effort DeepSeek Flash tool-loop pass when
    // a checkout is available and Codex isn't already exploring the repo.
    if (wantInvestigate && agentRepoDir && investigateModel) {
      const invFocus =
        'INVESTIGATE PASS — P1-FIRST multi-hop search with tools. Prioritize only ' +
        'Critical/High defects this PR introduces or exposes: auth/authz bypass, data ' +
        'loss/corruption, resource leak on failure, asymmetric error paths (success records ' +
        'X but failure skips it), dead checks after refactor, post-transform null/inconsistency, ' +
        'and cross-tenant/identity scoping bugs. Procedure: (1) list symbols this diff deletes ' +
        'or renames and grep their remaining callers; (2) for each changed function, read its ' +
        'full body + immediate callers/callees; (3) compare success vs failure/cleanup paths; ' +
        '(4) kill hypotheses that the code already handles. Report only concrete P1/P2 bugs ' +
        'with file:line and a failure scenario — no style/nits.';
      reviewCalls.push({
        label: `pass investigate (${investigateModel.target.model})`,
        kind: 'pass',
        mode: 'investigate',
        ctx: { ...passCtx, extraFocus: invFocus },
        target: investigateModel.target,
        tier: investigateModel.tier,
        passTag: 'investigate',
        sample: 0,
        // Distinct index so required-lens accounting never treats this as a core pass.
        modelPassIndex: 100,
        bestEffort: true,
      });
      console.log(`[worker] investigate pass enabled on ${investigateModel.target.model}`);
    }

    // Sweep batches: pack MANY files per call (each clipped smaller — the sweep is
    // for breadth/cross-file interactions, not deep-reading every file), so 100
    // files become a handful of calls instead of ~100.
    const sweepSource = plan.repoSweep ? (reviewContext?.others ?? []).slice(plan.retrievalTopK) : [];
    if (sweepSource.length > 0) {
      // P3-7: sweep cost tier must derive from the plan, not be hard-coded premium.
      const sweepModel = modelForPass(config, plan, 0, useCodexCli);
      const budget = Number(process.env.ORVEX_MAX_OTHER_CHARS ?? 45_000) - 2_000;
      // Read a meaningful chunk of each swept file (deeper than a skim) so the
      // Verify sweep is thorough, not just broad. ~4 files/batch at this size.
      const perFile = Number(process.env.ORVEX_SWEEP_FILE_CHARS ?? 10_000);
      let batch: Array<{ path: string; content: string }> = [];
      let used = 0;
      const pushBatch = () => {
        if (batch.length === 0) return;
        const files = batch;
        reviewCalls.push({
          label: `sweep (${files.length}f)`,
          kind: 'sweep',
          mode: useCodexCli && sweepModel.tier === 'openai' ? 'agentic' : 'api',
          ctx: { ...baseCtx, related: [], dependents: [], others: files },
          target: sweepModel.target,
          tier: sweepModel.tier,
          sample: 0,
        });
        batch = [];
        used = 0;
      };
      for (const f of sweepSource) {
        const content = f.content.length > perFile ? `${f.content.slice(0, perFile)}\n… (truncated)` : f.content;
        if (used + content.length > budget && batch.length > 0) pushBatch();
        batch.push({ path: f.path, content });
        used += content.length;
      }
      pushBatch();
    }

    const requestedAggregation = readReviewAggregationConfig();
    // Investigate is a single stateful tool-loop — never multiply via aggregation.
    const investigateCalls = reviewCalls.filter((call) => call.mode === 'investigate');
    const passCalls = reviewCalls.filter((call) => call.kind === 'pass' && call.mode !== 'investigate');
    const sweepCalls = reviewCalls.filter((call) => call.kind === 'sweep');
    // Reserve the sweep + investigate before expanding repeated samples.
    const reservedFixedCalls = Math.min(
      sweepCalls.length + investigateCalls.length,
      Math.max(0, maxCalls - passCalls.length),
    );
    const aggregation = fitReviewAggregationToBudget(
      requestedAggregation,
      passCalls.length,
      maxCalls,
      reservedFixedCalls,
    );
    if (requestedAggregation.enabled && !aggregation.enabled) {
      console.warn(`[worker] repeated-review aggregation disabled: ${aggregation.disabledReason}`);
    }

    let toRun: ReviewCall[];
    if (aggregation.enabled) {
      const repeatedCalls: ReviewCall[] = Array.from({ length: aggregation.effectiveRuns }, (_, sample) =>
        passCalls.map((call): ReviewCall => {
          // Sample 0 keeps the ORIGINAL call untouched — including agentic CLI
          // mode with its repo-exploration shell access. Aggregation must never
          // silently downgrade pass 0 to a single-shot API call: the CLI is a
          // capability (rg/cat/git over the checkout), not just a model choice.
          if (sample === 0) {
            return { ...call, label: `${call.label} sample 1/${aggregation.effectiveRuns}`, sample };
          }
          // Agentic Codex sessions are deliberately sequential and stateful.
          // Repeated samples must be independent, so samples 1+ select the
          // equivalent direct API target rather than resuming a shared CLI
          // conversation.
          const routed = modelForPass(config, plan, call.modelPassIndex ?? 0, false);
          return {
            ...call,
            label: `${call.label} sample ${sample + 1}/${aggregation.effectiveRuns}`,
            mode: 'api',
            target: routed.target,
            tier: routed.tier,
            sample,
            temperature: aggregation.temperature,
          };
        }),
      ).flat();
      // Pin investigate under the call budget the same way the non-aggregation
      // branch does — a full repeated sample grid must not silently truncate it.
      const invRoom = Math.max(0, maxCalls - investigateCalls.length);
      toRun = [
        ...repeatedCalls.slice(0, invRoom),
        ...investigateCalls,
        ...sweepCalls,
      ].slice(0, maxCalls);
      if (investigateCalls.length > 0 && !toRun.some((call) => call.mode === 'investigate')) {
        console.warn('[worker] investigate skipped: maxCalls budget exhausted before investigate');
        skippedLenses.push('investigate (call budget exhausted)');
      }
    } else {
      // Keep investigate even under a tight maxCalls budget — it is appended last
      // but is the whole point of the sandboxed tier when enabled.
      const inv = reviewCalls.filter((call) => call.mode === 'investigate');
      const rest = reviewCalls.filter((call) => call.mode !== 'investigate');
      const room = Math.max(0, maxCalls - inv.length);
      toRun = [...rest.slice(0, room), ...inv].slice(0, maxCalls);
      if (inv.length > 0 && !toRun.some((call) => call.mode === 'investigate')) {
        console.warn('[worker] investigate skipped: maxCalls budget exhausted before investigate');
        skippedLenses.push('investigate (call budget exhausted)');
      }
    }
    {
      const sweepCount = toRun.filter((call) => call.kind === 'sweep').length;
      console.log(
        `[worker] deep review: ${toRun.length} calls (${toRun.length - sweepCount} pass calls + ${sweepCount} sweep), ` +
          `concurrency=${concurrency}${aggregation.enabled ? `, aggregation=${aggregation.effectiveRuns}x/${aggregation.minOccurrences}` : ''}`,
      );
    }

    // Mid-run abort: a Verify review can run ~10 minutes across many calls — if
    // the PR closes/merges partway through (the real incident this fixes: a
    // backlog job finishing a full expensive review on a PR closed minutes into
    // the run), stop starting NEW calls and skip posting entirely. Calls already
    // in flight finish naturally (aborting a live HTTP request mid-stream isn't
    // worth the added risk); checking before every new call is what stops the
    // bulk of the remaining work. Best-effort: a failed check never itself
    // aborts the review.
    let prClosedMidRun = false;
    const abortPollMs = Math.max(5_000, Number(process.env.ORVEX_ABORT_POLL_MS ?? 45_000));
    const abortPoll = setInterval(() => {
      isPrStillOpen(octokit, ref)
        .then((open) => {
          if (!open && !prClosedMidRun) {
            prClosedMidRun = true;
            console.warn(`[worker] PR #${number} closed mid-review — stopping further model calls`);
          }
        })
        .catch(() => {});
    }, abortPollMs);

    type Outcome = {
      ok: boolean;
      transient: boolean;
      degraded: boolean;
      summary: string | undefined;
      findings: ReviewFinding[];
      kind: 'pass' | 'sweep';
      // Carried from the ReviewCall so the abort gate can exclude a failed
      // best-effort pass (breadth/deep-extra) from the "required pass" check.
      bestEffort?: boolean;
      /** human label ("pass 3/3 (perf/completeness/api) [MiniMax-M3]") for disclosure */
      label?: string;
      /** Repeated-review sample that produced this outcome. */
      sample: number;
      /** Original review lens, shared by every repeated sample of that lens. */
      modelPassIndex?: number;
    };

    /** What ONE call produced. `kind`/`bestEffort`/`label` are attached by
     *  runOne from the ReviewCall itself — this function only reports outcome,
     *  so no return site can misdescribe what the call WAS. */
    type CallResult = Omit<Outcome, 'kind' | 'bestEffort' | 'label' | 'sample' | 'modelPassIndex'>;

    const runSingleCall = async (call: (typeof toRun)[number]): Promise<CallResult> => {
      if (prClosedMidRun) {
        return { ok: false, transient: false, degraded: false, summary: undefined, findings: [] };
      }
      try {
        if (call.mode === 'agentic') {
          try {
            const { response, threadId } = await runCodexCliReview(filesForLlm, {
              threadId: codexThreadId,
              model: call.target.model,
              reasoningEffort: call.target.reasoningEffort,
              context: call.ctx,
              cwd: codexRepoDir ?? undefined,
              repoId: `${owner}/${repo}`,
              // Without this the agentic pass — by far the most expensive — was
              // reported as $0 and spend was invisible exactly where it matters.
              onUsage: onUsageFor(call.tier),
            });
            codexThreadId = threadId;
            const got = llmFindingsToReviewFindings(response.findings);
            tagFindings(got, call.tier, call.passTag); // codex findings → protected in verification
            const degraded = got.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
            console.log(`[worker] ${call.label}: +${got.length} findings${degraded ? ' (degraded/unparseable)' : ''}`);
            return { ok: !degraded, transient: false, degraded, summary: response.summary, findings: got };
          } catch (err) {
            const msg = (err as Error).message;
            // FALLBACK CHAIN on a codex CLI failure (mechanical — spawn/sandbox
            // error, bad key, etc. With API-key auth there's no more "OAuth
            // revoked" case). Try same-model plain API first (still the
            // intended frontier pass, just without repo exploration); only
            // drop to DeepSeek if that's unavailable/also fails.
            if (config.openaiModel) {
              try {
                console.error(
                  `[worker] ${call.label} codex CLI failed — retrying as plain API call (${config.openaiModel.model}): ${msg.slice(0, 140)}`,
                );
                const llm = await runReview(call.ctx, config.openaiModel, 'openai');
                const got = llmFindingsToReviewFindings(llm.findings);
                tagFindings(got, 'openai', call.passTag);
                const degraded = got.length === 0 && llm.summary === REVIEW_INCOMPLETE_SUMMARY;
                console.log(`[worker] ${call.label} [api-fallback]: +${got.length} findings${degraded ? ' (degraded/unparseable)' : ''}`);
                return { ok: !degraded, transient: false, degraded, summary: llm.summary, findings: got };
              } catch (apiErr) {
                console.error(`[worker] ${call.label} plain API fallback also failed: ${(apiErr as Error).message.slice(0, 140)}`);
              }
            }
            // CHEAP BACKUP REVIEWER: last resort — DeepSeek (heavy reasoner,
            // cheap, no OAuth) instead of losing the frontier pass entirely.
            // Dormant unless ORVEX_DEEPSEEK_API_KEY is set. Findings take the
            // normal (unprotected) verifier gate.
            if (!config.deepseekModel) throw err;
            console.error(`[worker] ${call.label} falling back to DeepSeek (${config.deepseekModel.model})`);
            const llm = await runReview(call.ctx, config.deepseekModel, 'deepseek');
            const got = llmFindingsToReviewFindings(llm.findings);
            tagFindings(got, 'deepseek', call.passTag);
            const degraded = got.length === 0 && llm.summary === REVIEW_INCOMPLETE_SUMMARY;
            console.log(`[worker] ${call.label} [deepseek-fallback]: +${got.length} findings${degraded ? ' (degraded/unparseable)' : ''}`);
            return { ok: !degraded, transient: false, degraded, summary: llm.summary, findings: got };
          }
        }

        if (call.mode === 'investigate') {
          if (!agentRepoDir) {
            return { ok: false, transient: false, degraded: false, summary: undefined, findings: [] };
          }
          const response = await runInvestigateReview(filesForInvestigate, {
            cwd: agentRepoDir,
            apiKey: call.target.apiKey,
            model: call.target.model,
            baseUrl: call.target.baseUrl,
            api: call.target.api,
            reasoningEffort: call.target.reasoningEffort,
            context: call.ctx,
            onUsage: onUsageFor(call.tier),
          });
          const got = llmFindingsToReviewFindings(response.findings);
          tagFindings(got, call.tier, call.passTag ?? 'investigate');
          const degraded = got.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
          console.log(`[worker] ${call.label}: +${got.length} findings${degraded ? ' (degraded/unparseable)' : ''}`);
          return { ok: !degraded, transient: false, degraded, summary: response.summary, findings: got };
        }

        const llm = await runReview(call.ctx, call.target, call.tier, call.temperature);
        const got = llmFindingsToReviewFindings(llm.findings);
        tagFindings(got, call.tier, call.passTag);
        // A call that returned the "unparseable" sentinel with no findings
        // didn't really succeed — it degraded. Mark it NOT-ok so an all-degraded
        // review fails/retries instead of posting a contradictory clean pass.
        const degraded = got.length === 0 && llm.summary === REVIEW_INCOMPLETE_SUMMARY;
        console.log(`[worker] ${call.label}: +${got.length} findings${degraded ? ' (degraded/unparseable)' : ''}`);
        return { ok: !degraded, transient: false, degraded, summary: llm.summary, findings: got };
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(`[worker] ${call.label} failed:`, msg);
        return {
          ok: false,
          transient: isTransientLlmError(msg),
          degraded: false,
          summary: undefined,
          findings: [],
        };
      }
    };

    let outcomes: Outcome[];
    try {
      // Agentic Codex calls share one session per PR, so they must run
      // sequentially. Investigate is stateful but independent of API passes
      // and runs in parallel with them below. API calls parallelize.
      const cliCalls = toRun.filter((c) => c.mode === 'agentic');
      const investigateCalls = toRun.filter((c) => c.mode === 'investigate');
      const apiCalls = toRun.filter((c) => c.mode === 'api');
      // Describe the outcome from the CALL, in exactly one place. Previously
      // `kind` was recomputed at every return site inside runSingleCall and
      // coerced ('codex-cli' -> 'pass'), which made a failed agentic SWEEP look
      // like a failed required PASS and abort the whole review.
      const runOne = async (call: (typeof toRun)[number]): Promise<Outcome> => ({
        ...(await runSingleCall(call)),
        kind: call.kind,
        bestEffort: call.bestEffort ?? false,
        label: call.label,
        sample: call.sample,
        modelPassIndex: call.modelPassIndex,
      });
      const cliOutcomes: Outcome[] = [];
      for (const call of cliCalls) {
        cliOutcomes.push(await runOne(call));
      }
      // Investigate is stateful but independent of API passes — run it in
      // parallel with them so the tool loop does not serialize the whole review.
      const [investigateOutcomes, apiOutcomes] = await Promise.all([
        mapLimit(investigateCalls, 1, runOne),
        mapLimit(apiCalls, concurrency, runOne),
      ]);
      // Core API outcomes first so any fallback summary walk still prefers them.
      outcomes = [...cliOutcomes, ...apiOutcomes, ...investigateOutcomes];
    } finally {
      clearInterval(abortPoll);
    }

    if (prClosedMidRun) {
      console.log(`[worker] PR #${number} closed during review — discarding partial results, not posting`);
      return {
        findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'pr_closed_mid_run',
        ...totalUsage(usage),
      };
    }

    // If NOTHING succeeded — whether rate-limit/transport (e.g. a MiniMax
    // token-plan 429) OR every pass degraded to an unparseable response — FAIL
    // the review so it retries, rather than posting an empty "0 findings" that
    // reads as a clean pass. A genuinely clean review has ok:true calls, so it's
    // correctly distinguished.
    const okCount = outcomes.filter((o) => o.ok).length;
    const transientCount = outcomes.filter((o) => o.transient).length;
    const degradedCount = outcomes.filter((o) => o.degraded).length;
    // If NO pass succeeded, NEVER post — regardless of how it failed. A systematic
    // error thrown before runLlmReview's own try (bad prompt build, an unmatched
    // provider error) surfaces as ok:false/transient:false/degraded:false on every
    // call; the old guard skipped those and posted a false "0 findings — clean"
    // review on a PR that was never actually reviewed. A real clean review has
    // ok:true calls, so it is still correctly distinguished.
    if (outcomes.length > 0 && okCount === 0) {
      const why =
        transientCount > 0
          ? 'rate-limit/transport errors (likely token-plan quota)'
          : degradedCount > 0
            ? 'unparseable model responses'
            : 'model calls errored before completing';
      throw new Error(
        `review aborted: all ${outcomes.length} model calls failed — ${why}. Will retry on the next push or \`@orvex review\`.`,
      );
    }

    // The core general + deep-dive lenses are the product contract. In normal
    // mode each needs one completed call; in repeated mode each needs enough
    // independent samples to meet the recurrence threshold. Breadth/deep-extra
    // lenses remain best-effort and cannot discard the completed core review.
    const requiredCalls = toRun.filter((call) => call.kind === 'pass' && !call.bestEffort);
    const requiredLensIds = [...new Set(requiredCalls.map((call) => call.modelPassIndex ?? -1))];
    // A required lens aborts the review only when it has ZERO successful
    // samples — the pre-aggregation semantics. Requiring minOccurrences
    // successes here aborted whole reviews (discarding every OTHER lens's
    // completed sample set and the sweep) whenever one model was flaky for
    // 4 of 5 samples, and a correlated TPM squeeze made the requeued retry
    // re-fire the identical burst into the same window. A lens with 1..min-1
    // successes instead DEGRADES below (posted with a disclosure): its
    // findings can still recur via other samples' lenses, and losing solo
    // findings to manual review beats losing the entire review.
    const requiredSuccesses = 1;
    const failedRequiredLenses = failedRequiredLensIds(requiredLensIds, outcomes, requiredSuccesses);
    if (failedRequiredLenses.length > 0) {
      // PRESERVE TRANSIENCE. queue-runner decides whether to requeue by pattern-
      // matching this message with isTransientLlmError; naming it keeps a
      // rate-limited required lens retryable rather than silently partial.
      const failedRequiredPasses = outcomes.filter(
        (outcome) =>
          failedRequiredLenses.includes(outcome.modelPassIndex ?? -1) && !outcome.bestEffort && !outcome.ok,
      );
      const transientFailures = failedRequiredPasses.filter((outcome) => outcome.transient).length;
      const cause = transientFailures > 0
        ? ' — rate-limit/transport errors; will retry'
        : '; no partial review was posted';
      throw new Error(
        `review aborted: ${failedRequiredLenses.length}/${requiredLensIds.length} required review lens(es) ` +
          `completed fewer than ${requiredSuccesses} sample(s)${cause}`,
      );
    }
    // `deep:` labels come from DEEP_EXTRA_ANGLES — the lenses the 2x charge buys.
    deepLensesRan = outcomes.some((o) => o.ok && (o.label ?? '').includes('deep:'));
    // Under aggregation a best-effort LENS is only "skipped" when EVERY sample
    // of it failed — one failed sample out of five must not brand a satisfied
    // review "(incomplete)" or list five duplicate per-sample labels.
    const sampleBase = (label: string | undefined): string =>
      (label ?? 'unnamed pass').replace(/ sample \d+\/\d+$/, '');
    const failedBestEffort = outcomes.filter((o) => o.kind === 'pass' && !o.ok && o.bestEffort);
    const okBestEffortBases = new Set(
      outcomes.filter((o) => o.kind === 'pass' && o.ok && o.bestEffort).map((o) => sampleBase(o.label)),
    );
    const skippedBestEffort = aggregation.enabled
      ? [...new Set(failedBestEffort.map((o) => sampleBase(o.label)))].filter((b) => !okBestEffortBases.has(b))
      : failedBestEffort.map((o) => o.label ?? 'unnamed pass');
    if (skippedBestEffort.length > 0) {
      skippedLenses = [...new Set([...skippedLenses, ...skippedBestEffort])];
      console.warn(
        `[worker] ${skippedBestEffort.length} best-effort pass(es) failed (${skippedLenses.join(', ')}) — ` +
          `posting the review from the core passes that completed, WITH a disclosure banner`,
      );
    }
    if (aggregation.enabled) {
      // Aggregation degradation (see requiredSuccesses above): a required lens
      // with some but < minOccurrences successes can't reach the recurrence
      // gate on its own samples — disclose it rather than abort.
      const underSampled = requiredLensIds.filter((id) => {
        const okCount = outcomes.filter(
          (o) => (o.modelPassIndex ?? -1) === id && o.kind === 'pass' && !o.bestEffort && o.ok,
        ).length;
        return okCount >= 1 && okCount < aggregation.minOccurrences;
      });
      if (underSampled.length > 0) {
        const labels = underSampled.map((id) => {
          const ok = outcomes.filter(
            (o) => (o.modelPassIndex ?? -1) === id && o.kind === 'pass' && !o.bestEffort && o.ok,
          ).length;
          return `lens ${id + 1} (${ok}/${aggregation.effectiveRuns} samples)`;
        });
        skippedLenses = [...skippedLenses, ...labels];
        console.warn(
          `[worker] aggregation degraded — required lens(es) under-sampled: ${labels.join(', ')}; ` +
            'posting with a disclosure instead of aborting',
        );
      }
    }

    // Summary from the first successful REQUIRED pass — best-effort lenses
    // (investigate, deep extras, breadth) must not steal the PR headline.
    llmSummary =
      outcomes.find((o) => o.kind === 'pass' && o.ok && !o.bestEffort)?.summary ??
      outcomes.find((o) => o.kind === 'pass' && o.ok)?.summary ??
      llmSummary;
    for (const o of outcomes) accumulated.push(...o.findings);

    const dedupeFindings = (findings: ReviewFinding[]): ReviewFinding[] => {
      const seenFp = new Set<string>();
      return findings.filter((finding) => {
        const fp = fingerprintFinding(finding);
        if (seenFp.has(fp)) return false;
        seenFp.add(fp);
        return true;
      });
    };
    if (aggregation.enabled) {
      const repeated = outcomes
        .filter((outcome) => outcome.kind === 'pass' && outcome.ok && outcome.modelPassIndex !== 100)
        .flatMap((outcome) => outcome.findings.map((finding) => ({ sample: outcome.sample, finding })));
      const mergedRepeated = await aggregateRepeatedFindings(repeated, {
        minOccurrences: aggregation.minOccurrences,
        maxCandidates: aggregation.maxCandidates,
        mergeWithLlm: (system, user) =>
          llmChat(system, user, {
            apiKey: llm.apiKey,
            model: llm.model,
            baseUrl: llm.baseUrl,
            api: llm.api,
            reasoningEffort: llm.reasoningEffort,
            temperature: aggregation.temperature,
            json: true,
            onUsage: onUsageFor(verificationTier),
          }),
      });
      aggregationManualCandidates = mergedRepeated.reviewOnly;
      // Sweep + investigate are single-shot (not repeated) — union them like sweep,
      // otherwise unique tool-loop findings die at the recurrence threshold.
      const sweepFindings = outcomes
        .filter((outcome) => outcome.kind === 'sweep' && outcome.ok)
        .flatMap((outcome) => outcome.findings);
      const investigateFindings = outcomes
        .filter((outcome) => outcome.ok && outcome.modelPassIndex === 100)
        .flatMap((outcome) => outcome.findings);
      llmFindings = dedupeFindings([...mergedRepeated.findings, ...sweepFindings, ...investigateFindings]);
      console.log(
        `[worker] repeated aggregation ${mergedRepeated.usedLlmMerge ? 'LLM-merged' : 'fingerprint-fallback'}: ` +
          `${mergedRepeated.findings.length} recurring, ${mergedRepeated.reviewOnly.length} manual, ` +
          `${mergedRepeated.clusterCount} clusters` +
          (investigateFindings.length ? `, ${investigateFindings.length} investigate` : ''),
      );
    } else {
      // Normal reviews union independently focused passes by stable fingerprint.
      llmFindings = dedupeFindings(accumulated);
    }
    // Don't let a failed first pass ("Review could not be completed…") headline
    // the review when later passes/sweep batches actually found bugs.
    if (llmFindings.length > 0 && llmSummary?.startsWith('Review could not be completed')) {
      llmSummary = undefined;
    }
    console.log(`[worker] deep review done: ${toRun.length} model calls, ${llmFindings.length} unique findings`);
    // Pre-dedupe accumulation preserves multi-tier/lens overlap; unique merge
    // keeps only one survivor per fingerprint.
    const preVerifyContribution = summarizeModelContribution(accumulated);
    console.log(
      `[worker] model contribution (pre-dedupe): ${formatModelContribution(preVerifyContribution)}`,
    );
    const uniqueContribution = summarizeModelContribution(llmFindings);
    console.log(
      `[worker] model contribution (unique): ${formatModelContribution(uniqueContribution)}`,
    );
    } finally {
      if (agentRepoDir) {
        try {
          fs.rmSync(agentRepoDir, { recursive: true, force: true });
        } catch {
          /* best-effort temp cleanup */
        }
      }
    }
  }

  // `mergeFindings` receives normal candidates separately from explicitly
  // demoted manual ones, so a higher-confidence one-off cannot displace a
  // deterministic, recurring, or sweep finding with the same fingerprint.
  const incoming = dedupeByFileLine([...ruleFindings, ...llmFindings]);
  const merged = mergeFindings(incoming, verifiedOpen, effectiveSha, {
    manualCandidates: aggregationManualCandidates,
    // Only files actually looked at this run can retire a prior finding. On an
    // incremental push `files` is just the newly-pushed diff, so a prior finding
    // in an un-touched file is carried forward, not falsely marked "fixed".
    reviewedFiles: new Set(files.map((f) => f.filename)),
    // P1-3: use the previous review's head SHA as the flip-flop guard, because
    // reconcileFixedOnHead no longer overwrites lastSeenSha for LLM/semgrep findings.
    priorReviewSha: priorState?.lastSha,
    // P2-4: findings whose files hit a transient read error must not be marked fixed.
    protectedFingerprints: new Set(readErrorFps),
  });

  // drop findings the team suppressed with `@orvex ignore`
  const suppressed = config.store.getSuppressedFingerprints(installationId, owner, repo);
  if (suppressed.size > 0) {
    merged.toPost = merged.toPost.filter((f) => !suppressed.has(fingerprintFinding(f)));
    merged.reviewOnly = merged.reviewOnly.filter(({ finding }) => !suppressed.has(fingerprintFinding(finding)));
  }

  // drop self-negating findings ("impact is nil", "harmless", "nitpick") — the
  // model padding its count with things it admits don't matter.
  const denoised = dropSelfNegatingFindings(merged.toPost);
  if (denoised.dropped.length > 0) {
    console.log(
      `[worker] noise filter dropped ${denoised.dropped.length}: ` +
        denoised.dropped.map((f) => `${f.severity} ${f.file}`).join(', '),
    );
  }
  merged.toPost = denoised.kept;
  const manualDenoised = dropSelfNegatingFindings(merged.reviewOnly.map(({ finding }) => finding));
  if (manualDenoised.dropped.length > 0) {
    console.log(
      `[worker] noise filter removed ${manualDenoised.dropped.length} manual-review candidate(s): ` +
        manualDenoised.dropped.map((f) => `${f.severity} ${f.file}`).join(', '),
    );
  }
  const manualKept = new Set(manualDenoised.kept.map((f) => fingerprintFinding(f)));
  merged.reviewOnly = merged.reviewOnly.filter(({ finding }) => manualKept.has(fingerprintFinding(finding)));

  // adversarial verification pass: a skeptical second model call tries to
  // refute each finding against the source. Give it the changed code for EVERY
  // finding — full file content where deep-context fetched it, else the file's
  // diff — so it never rejects a real finding just because it "can't see the
  // source" (that was silently blanking valid reviews on large PRs).
  const verifyFiles = [...reviewContextFiles];
  const haveContent = new Set(reviewContextFiles.map((f) => f.path));
  for (const file of filesForLlm) {
    if (!haveContent.has(file.filename) && file.patch) {
      verifyFiles.push({ path: file.filename, content: `Diff (changed lines) for this file:\n${file.patch}` });
      haveContent.add(file.filename);
    }
  }
  // For the premium deepVerify pass, pull in dependency MANIFESTS (package.json,
  // etc.) so the strict verifier can reject premise-on-wrong-version false
  // positives (e.g. "you removed a required Prisma field" when package.json shows
  // a major version that no longer needs it). Only fetch ones that exist in the
  // tree, so no 404 spam, and only on tiers that run the strict pass.
  if (plan.deepVerify) {
    const MANIFESTS = new Set([
      'package.json', 'pnpm-workspace.yaml', 'requirements.txt', 'pyproject.toml',
      'go.mod', 'composer.json', 'Gemfile', 'Cargo.toml', 'pom.xml', 'build.gradle',
    ]);
    const changedManifests = filesForLlm
      .map((f) => f.filename)
      .filter((p) => MANIFESTS.has(p.split('/').pop() ?? ''));
    const treeManifests = repoTreePaths
      // P2-6: include monorepo manifests at depth 3 (e.g. apps/server/package.json).
      .filter((p) => MANIFESTS.has(p.split('/').pop() ?? '') && p.split('/').length <= 3)
      .slice(0, 6);
    const manifestPaths = Array.from(new Set([...changedManifests, ...treeManifests]));
    for (const mp of manifestPaths) {
      if (haveContent.has(mp)) continue;
      try {
        const content = await fetchFileContent(octokit, owner, repo, mp, effectiveSha);
        if (content) {
          verifyFiles.push({ path: mp, content: content.slice(0, 20_000) });
          haveContent.add(mp);
        }
      } catch {
        /* manifest absent or unreadable — the strict pass still runs without it */
      }
    }
  }
  let verificationIncomplete = false;
  let verificationUnavailableReason: string | undefined;
  const verificationCandidates = [
    ...merged.toPost,
    ...merged.reviewOnly.map(({ finding }) => finding),
  ];
  if (verificationCandidates.length > 0 && process.env.ORVEX_VERIFY !== '0' && verifyFiles.length > 0) {
    // Independent challenger (DeepSeek v4 Flash on multi-model), batched and
    // TPM-aware — NOT a second Luna discovery pass.
    const mode = plan.deepVerify ? 'strict' : 'recall';
    const verified = await verifyFindings(verificationCandidates, verifyFiles, {
      apiKey: llm.apiKey,
      model: llm.model,
      baseUrl: llm.baseUrl,
      api: llm.api,
      reasoningEffort: llm.reasoningEffort,
      strict: plan.deepVerify,
      verifierTier: verificationTier,
      // The batch is [...toPost, ...reviewOnly]. Manual candidates must not be
      // able to promote a normal finding's severity through `duplicateOf`.
      confirmedCount: merged.toPost.length,
      // P2-2: count verification tokens in the review's cost total.
      onUsage: onUsageFor(verificationTier),
    });
    if (verified.status === 'unavailable') {
      verificationIncomplete = true;
      verificationUnavailableReason = verified.unavailableReason;
      console.warn(
        `[worker] verification (${mode}) UNAVAILABLE — findings preserved without precision gate: ` +
          (verified.unavailableReason ?? 'unknown').slice(0, 160),
      );
    } else if (verified.status === 'partial') {
      console.warn(
        `[worker] verification (${mode}) PARTIAL — kept ${verified.kept.length}/${verificationCandidates.length}, ` +
          `${verified.unverified.length} unverified after batch failure` +
          (verified.unavailableReason ? `: ${verified.unavailableReason.slice(0, 120)}` : ''),
      );
    } else {
      console.log(
        `[worker] verification (${mode}) kept ${verified.kept.length}/${verificationCandidates.length}` +
          (verified.dropped.length ? `, routed ${verified.dropped.length} to manual` : '') +
          (verified.unverified.length ? `, ${verified.unverified.length} unverified` : ''),
      );
    }
    if (verified.dropped.length > 0) {
      console.log(
        `[worker] verification (${mode}) routed ${verified.dropped.length}/${verificationCandidates.length} to manual review: ` +
          verified.dropped.map((d) => `${d.finding.file} (${d.reason.slice(0, 60)})`).join(' | '),
      );
    }
    // Root-cause dedup (piggybacked on the same verifier call): the same bug
    // found by two passes at DIFFERENT lines sails through fingerprint dedup —
    // on PR93 that double-posted two separate bugs. Merged copies fold their
    // severity into the kept finding; the root cause still posts once.
    if (verified.duplicates.length > 0) {
      console.log(
        `[worker] verification merged ${verified.duplicates.length} duplicate finding(s): ` +
          verified.duplicates
            .map((d) => `${d.finding.file}:${d.finding.line ?? '?'} → dup of :${d.of.line ?? '?'}`)
            .join(', '),
      );
    }
    const disposition = partitionVerifiedFindings(merged.toPost, merged.reviewOnly, verified, {
      verifierTier: verificationTier,
    });
    if (disposition.verificationIncomplete) {
      verificationIncomplete = true;
      verificationUnavailableReason = disposition.unavailableReason ?? verificationUnavailableReason;
    }
    if (disposition.rescued.length > 0) {
      console.log(
        `[worker] verification: rescued ${disposition.rescued.length} strong-reasoner finding(s) dropped on hedged grounds: ` +
          disposition.rescued.map((d) => `${d.finding.sourceTier} ${d.finding.file}:${d.finding.line}`).join(', '),
      );
    }
    if (disposition.refuted.length > 0) {
      console.log(
        `[worker] verification: ${disposition.refuted.length} strong-reasoner finding(s) factually refuted and routed to manual review: ` +
          disposition.refuted.map((d) => `${d.finding.sourceTier} ${d.finding.file}:${d.finding.line} (${d.reason.slice(0, 60)})`).join(', '),
      );
    }
    merged.toPost = disposition.toPost;
    merged.reviewOnly = disposition.reviewOnly;
  } else if (verificationCandidates.length > 0 && process.env.ORVEX_VERIFY !== '0' && verifyFiles.length === 0) {
    verificationIncomplete = true;
    verificationUnavailableReason = 'Verification skipped: no source files available for the precision gate.';
    console.warn(`[worker] ${verificationUnavailableReason}`);
  }
  console.log(
    `[worker] model contribution (posted): ${formatModelContribution(summarizeModelContribution(merged.toPost))}`,
  );

  // snap finding lines to lines actually added in the diff — GitHub rejects
  // inline comments on unchanged lines; far-off guesses become summary-only
  const addedLinesByFile = buildAddedLineIndex(files);
  merged.toPost = merged.toPost.map((f) => normalizeFindingLine(f, addedLinesByFile));
  // Re-dedup AFTER anchoring: two passes (codex general + MiniMax deep-dive) can
  // report the same defect and only collide on line once snapped to the nearest
  // added line — this collapses those into the highest-severity single comment.
  merged.toPost = dedupeByFileLine(merged.toPost);
  merged.reviewOnly = merged.reviewOnly.map((item) => ({
    ...item,
    finding: normalizeFindingLine(item.finding, addedLinesByFile),
  }));

  const allFixed = dedupeByFingerprint([...verifiedFixed, ...merged.newlyFixed]);
  let { inline, summaryOnly, nitpicks } = filterAndCapFindings(merged.toPost, reviewConfig);

  // cumulative cap: repeated re-reviews must never bury a PR in comments.
  // Once ORVEX_MAX_INLINE_PER_PR (default 100) inline comments exist across the
  // PR's lifetime, further findings go to the summary table only. High default:
  // every finding should carry its apply-fix checkbox; this is a runaway guard.
  const maxInlinePerPr = Number(process.env.ORVEX_MAX_INLINE_PER_PR ?? 100);
  const priorInline = (priorState?.findings ?? []).filter((f) => f.githubCommentId).length;
  const inlineBudget = Math.max(0, maxInlinePerPr - priorInline);
  if (inline.length > inlineBudget) {
    summaryOnly = [...summaryOnly, ...inline.slice(inlineBudget)];
    inline = inline.slice(0, inlineBudget);
    console.log(
      `[worker] inline budget: ${priorInline} existing, capping new inline to ${inlineBudget}`,
    );
  }

  const stats = {
    newCount: merged.toPost.length,
    fixedCount: allFixed.length,
    openCount: merged.stillOpen.length + merged.toPost.length,
  };

  let reviewId: number | undefined;
  const commentIdMap = new Map<string, number>();

  // ALWAYS post a review — even with zero findings — so a completed review is
  // never silent. A clean review still reports the files it read, an assessment,
  // and what it checked for.
  {
    const summary =
      llmSummary ??
      (stats.fixedCount > 0
        ? `All previously reported issues appear fixed on \`${effectiveSha.slice(0, 7)}\`.`
        : undefined);

    const body = formatReviewBody(inline, summaryOnly, {
      owner,
      repo,
      pr: number,
      headSha: effectiveSha,
      stats,
      summary,
      filesReviewed: filesForLlm.map((f) => f.filename),
      isDeep: job.deep,
      skippedLenses: skippedLenses.length > 0 ? skippedLenses : undefined,
      coverage: coverage.complete
        ? undefined
        : { reviewed: coverage.reviewed, candidates: coverage.candidates, skippedByCap: coverage.skippedByCap, truncatedFiles: coverage.truncatedFiles, omittedPatch: coverage.omittedPatch },
      stillOpen: merged.stillOpen.map((f) => ({
        severity: f.severity,
        file: f.file,
        line: f.line,
        message: f.message,
      })),
      trigger: commandTrigger(),
      canAutofix: plan.autofix,
      reviewOnly: merged.reviewOnly,
      verificationIncomplete: verificationIncomplete
        ? (verificationUnavailableReason ?? 'Verification did not complete for this review.')
        : undefined,
    }, nitpicks);

    const inlineComments: InlineReviewComment[] = inline
      .filter((f) => f.line)
      .map((f) => ({
        path: f.file,
        line: f.line!,
        body: formatInlineBody(f, plan.autofix, reviewContextFiles),
      }));

    // Advisory by default: post as COMMENT (never blocks the PR). Set
    // ORVEX_REQUEST_CHANGES=1 to use REQUEST_CHANGES on P1 findings.
    const hasP1 = merged.toPost.some((f) => f.severity === 'P1');
    const event =
      hasP1 && process.env.ORVEX_REQUEST_CHANGES === '1' ? 'REQUEST_CHANGES' : 'COMMENT';
    const review = await postPullRequestReview(octokit, ref, effectiveSha, body, inlineComments, event);
    reviewId = review.reviewId;

    for (const c of review.commentIds) {
      commentIdMap.set(`${c.path}:${c.line}`, c.id);
    }

    // Findings that could NOT be anchored to a diff line (file not in this
    // diff / no line) land in the summary table — which had NO apply button
    // (real complaint: 3 findings, 1 button). Give each one its own PR-level
    // comment with a working apply checkbox (the issue-comment checkbox path
    // in webhook.ts handles the tick). Capped to avoid comment spam.
    if (plan.autofix && summaryOnly.length > 0) {
      const cap = Number(process.env.ORVEX_MAX_UNANCHORED_COMMENTS ?? 3);
      for (const f of summaryOnly.slice(0, cap)) {
        const fp = fingerprintFinding(f);
        const parts = [
          `**${f.severity}** · \`${f.file}${f.line ? `:${f.line}` : ''}\` · \`${f.ruleId}\``,
          '',
          f.message,
        ];
        if (f.fixedCode) parts.push('', '```suggestion-preview', f.fixedCode, '```');
        parts.push('', applyCheckboxLine(fp, f.fixedCode !== undefined));
        try {
          await replyToIssueComment(octokit, ref, parts.join('\n'));
        } catch (err) {
          console.warn('[worker] unanchored-finding comment failed:', (err as Error).message);
        }
      }
    }
  }

  const newStored: StoredFinding[] = merged.toPost.map((f) => {
    const stored = toStoredFinding(f, effectiveSha);
    const key = f.line ? `${f.file}:${f.line}` : null;
    if (key && commentIdMap.has(key)) {
      stored.githubCommentId = commentIdMap.get(key);
    }
    return stored;
  });

  const fixedFps = new Set(allFixed.map((f) => f.fingerprint));
  const incomingFpSet = new Set(merged.toPost.map((f) => fingerprintFinding(f)));

  const updatedPrior = (priorState?.findings ?? []).map((f) => {
    const fixed = allFixed.find((x) => x.fingerprint === f.fingerprint);
    if (fixed) return fixed;
    const still = merged.stillOpen.find((x) => x.fingerprint === f.fingerprint);
    if (still) return still;
    // P3-6: a previously-fixed finding that reappears must be reopened, not
    // re-posted as a duplicate comment and not left as "fixed" in the store.
    if (f.status === 'fixed' && incomingFpSet.has(f.fingerprint)) {
      const reborn = merged.toPost.find((x) => fingerprintFinding(x) === f.fingerprint);
      if (reborn) {
        return {
          ...toStoredFinding(reborn, effectiveSha),
          status: 'open' as const,
          firstSeenSha: f.firstSeenSha,
        };
      }
    }
    if (fixedFps.has(f.fingerprint)) {
      return { ...f, status: 'fixed' as const, fixedAtSha: effectiveSha };
    }
    return f;
  });

  const knownFps = new Set(updatedPrior.map((f) => f.fingerprint));
  const finalFindings = [
    ...updatedPrior,
    ...newStored.filter((s) => !knownFps.has(s.fingerprint)),
  ];

  // Persist manual-review candidates so `@orvex ignore <file>:<line>` can
  // resolve them. They have no inline comment, so the thread-reply form of
  // `ignore` (which matches on githubCommentId) can never reach them — leaving
  // the team no way to silence a candidate that reappears on every push. The
  // suppression filter at the top of this function already covers reviewOnly;
  // it simply never had a route to receive their fingerprints.
  const manualStored: StoredFinding[] = merged.reviewOnly.map(({ finding }) =>
    toStoredFinding(finding, effectiveSha),
  );

  const state: PrReviewState = {
    installationId,
    tenantId,
    owner,
    repo,
    pr: number,
    lastSha: effectiveSha,
    findings: finalFindings,
    manualReview: manualStored,
    lastReviewAt: new Date().toISOString(),
    codexThreadId,
  };
  config.store.saveState(state);

  // update the dashboard PR row with the latest open-finding count
  const openCount = finalFindings.filter((f) => f.status === 'open').length;
  config.store.markReviewedNow(installationId, `${owner}/${repo}`, number, openCount);

  if (config.enableCheckRuns) {
    // Manual-review candidates count toward the check run's honesty signals.
    // `finalFindings` comes only from `merged.toPost`, so a review where EVERY
    // candidate was demoted (by recurrence or all vetoed by the
    // verifier) previously produced: conclusion 'success', "0 new, 0 fixed,
    // 0 open", and a green ✅ next to the merge button — while the review body
    // directly below rendered a table of P1 candidates. That is precisely the
    // false assurance the `incomplete` branch exists to prevent; 18eeb90 added
    // a new way to reach it by routing demoted findings to a surface the
    // check-run path never learned about.
    const manualP1 = merged.reviewOnly.some(({ finding }) => finding.severity === 'P1');
    const manualAny = merged.reviewOnly.length > 0;
    const openP1 = finalFindings.some((f) => f.status === 'open' && f.severity === 'P1') || manualP1;
    const openAny = finalFindings.some((f) => f.status === 'open') || manualAny;
    // Advisory: never fail the check (no red ✗). Findings show as 'neutral';
    // set ORVEX_FAIL_CHECK_ON_P1=1 to hard-fail on open P1s if you want gating.
    // A green ✅ next to the merge button is the strongest signal Orvex sends. It
    // must never say "success" when one of the promised passes never ran — that
    // directly contradicts the "did not complete" banner in the review body and
    // is exactly the false assurance the banner exists to prevent.
    const incomplete = skippedLenses.length > 0 || verificationIncomplete;
    const conclusion =
      openP1 && process.env.ORVEX_FAIL_CHECK_ON_P1 === '1'
        ? 'failure'
        : openAny || incomplete
          ? 'neutral'
          : 'success';
    // Name the demoted candidates in the summary too. "0 new, 0 fixed, 0 open"
    // is technically true of the posted set but reads as "nothing found", which
    // is the opposite of what a body full of manual-review rows means.
    const manualNote = manualAny
      ? ` · ${merged.reviewOnly.length} candidate(s) need manual review${manualP1 ? ' (incl. P1)' : ''}`
      : '';
    const verifyNote = verificationIncomplete
      ? ' · verification incomplete (NOT a full precision sign-off)'
      : '';
    const summary = `${stats.newCount} new, ${stats.fixedCount} fixed, ${stats.openCount} open${manualNote}${verifyNote}`;
    await createCheckRun(octokit, ref, effectiveSha, {
      conclusion,
      title: incomplete ? 'Orvex Review (incomplete)' : 'Orvex Review',
      summary: incomplete
        ? skippedLenses.length > 0
          ? `${summary} — ${skippedLenses.length} review pass(es) did not complete; NOT a full sign-off`
          : `${summary} — precision verification did not complete; NOT a full sign-off`
        : summary,
    });
  }

  // ——— Tier-2 (Verify plan): runtime verification in a sandbox ———
  // Gated by BOTH the tenant's plan (codeExecution) and ORVEX_CODE_EXECUTION=1,
  // so it never runs for lower tiers and stays off until execution is enabled.
  if (plan.codeExecution && process.env.ORVEX_CODE_EXECUTION === '1') {
    try {
      console.log(`[worker] tier-2 runtime verify (plan=${plan.id}) PR #${number}…`);
      const rv = await runtimeVerify(octokit, owner, repo, effectiveSha, { baseSha: pr.baseSha });
      const evidence = formatRuntimeEvidence(rv);
      if (evidence) {
        await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body: evidence });
        console.log(`[worker] tier-2 runtime verify posted: ran=${rv.ran} steps=${rv.steps.length}`);
      } else {
        console.log(`[worker] tier-2 runtime verify skipped: ${rv.skippedReason}`);
      }
    } catch (err) {
      console.warn('[worker] tier-2 runtime verify failed (non-fatal):', (err as Error).message);
    }
  }

  console.log(
    `[worker] done PR #${number}: ${stats.newCount} new, ${stats.fixedCount} fixed, ${stats.openCount} open`,
  );

  const { inputTokens, outputTokens, costUsd } = totalUsage(usage);
  if (inputTokens + outputTokens > 0) {
    const mix = plan.modelTier === 'hybrid' ? ' (hybrid: MiniMax+GLM)' : '';
    console.log(`[worker] PR #${number} usage${mix}: ${inputTokens} in + ${outputTokens} out ≈ $${costUsd.toFixed(4)}`);
  }

  return {
    findingCount: stats.openCount,
    newCount: stats.newCount,
    fixedCount: stats.fixedCount,
    reviewId,
    inputTokens,
    outputTokens,
    costUsd,
    newFindings: merged.toPost.map((f) => ({ severity: f.severity, file: f.file, line: f.line })),
    deepLensesRan,
  };
}

/**
 * Dashboard defaults apply when a repository has no config-as-code file.
 * Previously maxComments/reviewMode were stored and shown by the product but
 * silently ignored by the worker, which also made the public
 * "8 comments by default" promise untrue. A checked-in repo config remains the
 * source of truth when present.
 */
export function effectiveReviewConfig(
  repoConfigYaml: string | null,
  workspace: { defaultReviewMode: 'normal' | 'strict'; maxComments: number },
  repoReviewMode?: 'normal' | 'strict',
): ReviewConfig {
  const parsed = parseReviewConfigYaml(repoConfigYaml);
  if (repoConfigYaml?.trim()) return parsed;
  return {
    ...parsed,
    mode: repoReviewMode ?? workspace.defaultReviewMode,
    max_comments: workspace.maxComments,
  };
}

async function runDeterministicRules(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  headSha: string,
  files: Array<{ filename: string; status: string }>,
  config: ReviewConfig,
): Promise<ReviewFinding[]> {
  const findings: ReviewFinding[] = [];

  for (const file of files) {
    if (shouldIgnorePath(file.filename, config)) continue;

    if (file.filename.endsWith('.md')) {
      const content = await fetchFileContent(octokit, owner, repo, file.filename, headSha);
      if (content) {
        findings.push(
          ...auditFindingsFromContent(content, file.filename).map((f) => ({
            ...f,
            severity: f.severity as ReviewFinding['severity'],
          })),
        );
      }
    }
  }

  if (config.run_semgrep) {
    const paths = files
      .map((f) => f.filename)
      .filter((p) => !shouldIgnorePath(p, config) && /\.(js|ts|jsx|tsx|py|go)$/.test(p));
    const semgrep = await runSemgrepOnPaths(paths);
    findings.push(
      ...semgrep.map((f) => ({
        ...f,
        severity: f.severity as ReviewFinding['severity'],
      })),
    );
  }

  // Deterministic import/export check: `const { x } = require('./m')` where
  // ./m never exports x is a guaranteed TypeError on first call. PR93's
  // getFileFromR2 bug (whole PITR feature dead) slipped past all 5 LLM passes —
  // a mechanical class gets a mechanical check. Best-effort: any fetch error
  // just skips the check; it must never fail a review.
  try {
    const jsChanged = files.filter(
      (f) =>
        f.status !== 'removed' &&
        /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(f.filename) &&
        !shouldIgnorePath(f.filename, config),
    );
    if (jsChanged.length > 0) {
      const cache = new Map<string, string | null>();
      const fetchCached = async (path: string): Promise<string | null> => {
        if (cache.has(path)) return cache.get(path) ?? null;
        let content: string | null = null;
        try {
          content = await fetchFileContent(octokit, owner, repo, path, headSha);
        } catch {
          content = null;
        }
        cache.set(path, content);
        return content;
      };
      const changedSources: Array<{ path: string; content: string }> = [];
      for (const f of jsChanged.slice(0, 60)) {
        const content = await fetchCached(f.filename);
        if (content) changedSources.push({ path: f.filename, content });
      }
      const importFindings = await checkImportBindings(changedSources, fetchCached);
      if (importFindings.length > 0) {
        console.log(
          `[worker] import check: ${importFindings.length} unresolved named import(s): ` +
            importFindings.map((f) => `${f.file}:${f.line}`).join(', '),
        );
      }
      findings.push(...importFindings);
    }
  } catch (err) {
    console.warn('[worker] import check skipped:', (err as Error).message);
  }

  return findings;
}

function formatInlineBody(
  f: ReviewFinding,
  canAutofix: boolean,
  contextFiles: Array<{ path: string; content: string }>,
): string {
  const content = contextFiles.find((x) => x.path === f.file)?.content;
  const anchoredLine = f.line && content ? content.split('\n')[f.line - 1] : undefined;
  return formatInlineFinding({
    finding: {
      severity: f.severity,
      ruleId: f.ruleId,
      message: f.message,
      suggestion: f.suggestion,
      originalCode: f.originalCode,
      fixedCode: f.fixedCode,
      fingerprint: fingerprintFinding(f),
      file: f.file,
      line: f.line,
    },
    trigger: commandTrigger(),
    canAutofix,
    anchoredLine,
    lineRelocated: f.lineRelocated,
    anchorContext: f.anchorContext,
  });
}

function dedupeByFingerprint(findings: StoredFinding[]): StoredFinding[] {
  const byFp = new Map<string, StoredFinding>();
  for (const f of findings) {
    byFp.set(f.fingerprint, f);
  }
  return [...byFp.values()];
}

type LineIndexEntry = { added: Set<number>; context: Set<number> };
type AddedLineMap = Map<string, LineIndexEntry>;

function buildAddedLineIndex(files: Array<{ filename: string; patch?: string }>): AddedLineMap {
  const map: AddedLineMap = new Map();
  for (const file of files) {
    if (!file.patch) continue;
    const idx = parseAddedLinesFromPatch(file.patch);
    if (idx.added.size > 0 || idx.context.size > 0) {
      map.set(file.filename, idx);
    }
  }
  return map;
}

function parseAddedLinesFromPatch(patch: string): LineIndexEntry {
  // P2-8 / P3-1 / P3-2: PREFER added lines for anchoring. Only fall back to
  // context lines for DELETION-ONLY hunks (+0/-N), where the removed code is
  // gone but the surrounding lines remain. Skip phantom lines from trailing
  // newlines and `\ No newline at end of file`.
  const added = new Set<number>();
  const context = new Set<number>();
  let newLine = 0;
  let hunkAdded = new Set<number>();
  let hunkContext: number[] = [];

  const flushHunk = () => {
    if (hunkAdded.size === 0) {
      for (const ln of hunkContext) context.add(ln);
    }
    hunkAdded = new Set();
    hunkContext = [];
  };

  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    // P3-1: ignore `\ No newline at end of file` and empty trailing entry.
    if (line.startsWith('\\')) continue;
    if (line === '' && i === lines.length - 1) continue;

    const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (match) {
      flushHunk();
      newLine = Number(match[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (newLine > 0) {
        added.add(newLine);
        hunkAdded.add(newLine);
      }
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      continue; // deleted line — no new-side number to anchor to
    }
    if (newLine > 0) {
      hunkContext.push(newLine);
      newLine += 1;
    }
  }
  flushHunk();

  return { added, context };
}

function normalizeFindingLine(finding: ReviewFinding, index: AddedLineMap): ReviewFinding {
  const fileIndex = index.get(finding.file);
  // file not part of the diff (pure deletion / unchanged) → summary-only
  if (!fileIndex || (fileIndex.added.size === 0 && fileIndex.context.size === 0)) {
    return { ...finding, line: undefined };
  }

  const { added, context } = fileIndex;

  // P2-8: exact hit on an added line is the safest anchor.
  if (finding.line && added.has(finding.line)) {
    return { ...finding, lineRelocated: false, anchorContext: false };
  }

  // Otherwise snap to the nearest added line.
  if (added.size > 0) {
    const anchor = nearestLine(added, finding.line);
    return { ...finding, line: anchor, lineRelocated: true, anchorContext: false };
  }

  // No added lines in this file's hunks → deletion-only. Use context lines.
  if (finding.line && context.has(finding.line)) {
    return { ...finding, lineRelocated: false, anchorContext: true };
  }
  const anchor = nearestLine(context, finding.line);
  return { ...finding, line: anchor, lineRelocated: true, anchorContext: true };
}

/** Nearest line in `set` to `requested`, or the first line if no hint. */
function nearestLine(set: Set<number>, requested?: number): number {
  let bestLine = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ln of set) {
    if (requested === undefined) {
      if (ln < bestLine) bestLine = ln;
      continue;
    }
    const distance = Math.abs(ln - requested);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLine = ln;
      if (distance === 0) break;
    }
  }
  return Number.isFinite(bestLine) ? bestLine : (requested ?? 1);
}
