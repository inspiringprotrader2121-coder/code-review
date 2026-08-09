import {
  DEFAULT_CODEX_CLI_MODEL,
  isCodexRepoAllowed,
  compileReviewPlan,
  type ReviewStage,
  type ReviewPromptContext,
} from '@orvex-review/review';
import type { LlmTarget, ModelTier, PassTier, WorkerConfig } from './worker-types.js';

function premiumTarget(config: WorkerConfig): LlmTarget {
  return {
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    api: config.llmApi,
    maxTokens: maxOutputTokensForModel(config.llmModel),
  };
}

export function maxOutputTokensForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const normalized = model.toLowerCase();
  const key = normalized.includes('deepseek')
    ? 'ORVEX_DEEPSEEK_MAX_OUTPUT_TOKENS'
    : normalized.includes('minimax')
      ? 'ORVEX_MINIMAX_MAX_OUTPUT_TOKENS'
      : undefined;
  if (!key) return undefined;
  const parsed = Number(env[key] ?? 24_000);
  return Number.isFinite(parsed)
    ? Math.min(64_000, Math.max(16_000, Math.floor(parsed)))
    : 24_000;
}

export function contextForReviewPass(
  context: ReviewPromptContext,
  modelPassIndex: number,
): ReviewPromptContext {
  const changed = [...(context.changedContents ?? [])];
  if (modelPassIndex === 2) changed.reverse();
  if (modelPassIndex >= 3 && changed.length > 1) {
    const midpoint = Math.floor(changed.length / 2);
    changed.push(...changed.splice(0, midpoint));
  }
  const common: ReviewPromptContext = { treePaths: context.treePaths, changedContents: changed };
  if (modelPassIndex === 1) return { ...common, related: context.related };
  if (modelPassIndex === 2) return { ...common, dependents: context.dependents };
  if (modelPassIndex >= 3) return { ...common, related: context.related, others: context.others };
  return { ...common, related: context.related, dependents: context.dependents, others: context.others };
}

export function canRunCodexCli(
  plan: { modelTier?: ModelTier },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ORVEX_CODEX_CLI === '1'
    && (plan.modelTier === 'codex-hybrid' || plan.modelTier === 'multi-model');
}

export function canRunAgentic(plan: { modelTier?: ModelTier }, repoId: string): boolean {
  return canRunCodexCli(plan) && isCodexRepoAllowed(repoId);
}

export function canRunInvestigate(
  plan: { id?: string; modelTier?: ModelTier },
  opts: { useCodexCli: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ORVEX_INVESTIGATE !== '1' || opts.useCodexCli) return false;
  return plan.modelTier === 'multi-model' || plan.modelTier === 'codex-hybrid';
}

export function canRunRiskHunt(
  plan: { modelTier?: ModelTier },
  opts: { highRisk: boolean; hasFlash: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ORVEX_RISK_HUNT !== '1' || !opts.highRisk || !opts.hasFlash) return false;
  return plan.modelTier === 'dual-model'
    || plan.modelTier === 'multi-model'
    || plan.modelTier === 'codex-hybrid';
}

export function modelForRiskHunt(
  config: WorkerConfig,
): { target: LlmTarget; tier: PassTier } | null {
  return config.deepseekFlashModel
    ? { target: config.deepseekFlashModel, tier: 'deepseek-flash' }
    : null;
}

export function modelForInvestigate(
  config: WorkerConfig,
  env: NodeJS.ProcessEnv = process.env,
): { target: LlmTarget; tier: PassTier } {
  const override = (env.ORVEX_INVESTIGATE_TIER ?? 'deepseek-flash').trim().toLowerCase();
  if (override === 'openai' && config.openaiModel) return { target: config.openaiModel, tier: 'openai' };
  if (override === 'deepseek' && config.deepseekModel) return { target: config.deepseekModel, tier: 'deepseek' };
  if (override === 'standard') return { target: config.standardModel, tier: 'standard' };
  if (config.deepseekFlashModel) return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
  if (config.deepseekModel) return { target: config.deepseekModel, tier: 'deepseek' };
  if (config.openaiModel) return { target: config.openaiModel, tier: 'openai' };
  return { target: config.standardModel, tier: 'standard' };
}

export function modelForPass(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
  passIndex: number,
  agentic = false,
): { target: LlmTarget; tier: PassTier } {
  const stage = compileReviewPlan(plan.modelTier)?.discovery.find((candidate) => candidate.modelIndex === passIndex);
  if (stage) return modelForReviewStage(config, stage, agentic);

  if (plan.modelTier === 'codex-hybrid') {
    if (passIndex === 0 && config.codexCliModel && agentic) {
      return { target: config.codexCliModel, tier: 'openai' };
    }
    if (passIndex === 0) throw new Error('high-tier Luna requires the pinned Codex CLI; direct API substitution is disabled');
    return { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'multi-model') {
    if (passIndex === 0 && config.codexCliModel && agentic) {
      return { target: config.codexCliModel, tier: 'openai' };
    }
    if (passIndex === 0) throw new Error('high-tier Luna requires the pinned Codex CLI; direct API substitution is disabled');
    if (passIndex === 1 || passIndex === 2) {
      if (config.deepseekFlashModel) {
        return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
      }
      throw new Error(`DeepSeek v4 Flash is required for multi-model pass ${passIndex + 1}`);
    }
    return { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'dual-model') {
    if (passIndex === 1) {
      if (config.deepseekFlashModel) {
        return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
      }
      throw new Error('DeepSeek v4 Flash is required for dual-model pass 2');
    }
    return { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'openai') {
    return config.openaiModel
      ? { target: config.openaiModel, tier: 'openai' }
      : { target: config.standardModel, tier: 'standard' };
  }
  if (plan.modelTier === 'hybrid') {
    return passIndex === 0
      ? { target: config.standardModel, tier: 'standard' }
      : { target: premiumTarget(config), tier: 'premium' };
  }
  if (plan.modelTier === 'standard') return { target: config.standardModel, tier: 'standard' };
  return { target: premiumTarget(config), tier: 'premium' };
}

/** Resolve a named public-plan stage. No default model is allowed here: a
 * missing contracted provider must fail before an unrelated provider spends. */
export function modelForReviewStage(
  config: WorkerConfig,
  stage: ReviewStage,
  agentic = false,
): { target: LlmTarget; tier: PassTier } {
  switch (stage.modelSlot) {
    case 'luna':
      if (config.codexCliModel && agentic) return { target: config.codexCliModel, tier: 'openai' };
      throw new Error('high-tier Luna requires the pinned Codex CLI; direct API substitution is disabled');
    case 'deepseek-flash':
      if (config.deepseekFlashModel) return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
      throw new Error(`DeepSeek v4 Flash is required for ${stage.id}`);
    case 'minimax':
      return { target: config.standardModel, tier: 'standard' };
  }
}

export function modelForPlanWithTier(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
): { target: LlmTarget; tier: PassTier } {
  const publicPlan = compileReviewPlan(plan.modelTier);
  if (publicPlan) return modelForReviewStage(config, publicPlan.verification);

  if (
    plan.modelTier === 'multi-model'
    || plan.modelTier === 'codex-hybrid'
    || plan.modelTier === 'dual-model'
  ) {
    if (config.deepseekFlashModel) {
      return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
    }
    throw new Error('DeepSeek v4 Flash is required for verification on this plan');
  }
  if (plan.modelTier === 'standard' || plan.modelTier === 'openai') {
    return { target: config.standardModel, tier: 'standard' };
  }
  return { target: premiumTarget(config), tier: 'premium' };
}

export function modelForPlan(config: WorkerConfig, plan: { modelTier?: ModelTier }): LlmTarget {
  return modelForPlanWithTier(config, plan).target;
}

export function validateNativeOpenAiResponsesConfig(
  baseUrl: string,
  api: string | undefined,
): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('ORVEX_OPENAI_BASE_URL must be a valid native OpenAI URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname.toLowerCase() !== 'api.openai.com'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname.replace(/\/+$/, '') !== '/v1'
  ) {
    throw new Error('direct Luna configuration must use https://api.openai.com/v1; gateways and custom paths are refused');
  }
  if (api !== undefined && api !== '' && api !== 'responses') {
    throw new Error('direct Luna configuration must use the OpenAI Responses API, not chat/completions');
  }
  return 'https://api.openai.com/v1';
}

export function hasPinnedCodexLuna(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
  repoId: string | undefined,
): boolean {
  return Boolean(
    repoId
    && canRunAgentic(plan, repoId)
    && config.codexCliModel?.model.trim().toLowerCase() === DEFAULT_CODEX_CLI_MODEL,
  );
}
