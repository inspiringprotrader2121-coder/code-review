import {
  DEFAULT_CODEX_CLI_MODEL,
  compileReviewPlan,
  type ReviewPromptContext,
} from '@orvex-review/review';
import type { LlmTarget, ModelTier, PassTier, WorkerConfig } from './worker-types.js';

export interface ReviewRoutingPolicy {
  codexCliEnabled: boolean;
  codexRepoAllowed: (repoId: string) => boolean;
  investigateEnabled: boolean;
  riskHuntEnabled: boolean;
  investigateTier: 'deepseek-flash' | 'deepseek' | 'openai' | 'standard';
  deepseekMaxOutputTokens: number;
  minimaxMaxOutputTokens: number;
}

export const DEEPSEEK_REVIEW_OUTPUT_TOKENS = 36_000;
// MiniMax's reasoning tokens share this response budget. 20k can end before it
// emits the required JSON for a complex review, despite a compact final answer.
export const MINIMAX_REVIEW_OUTPUT_TOKENS = 32_000;

export const DEFAULT_REVIEW_ROUTING_POLICY: ReviewRoutingPolicy = Object.freeze({
  codexCliEnabled: false,
  codexRepoAllowed: () => false,
  investigateEnabled: false,
  riskHuntEnabled: false,
  investigateTier: 'deepseek-flash',
  deepseekMaxOutputTokens: DEEPSEEK_REVIEW_OUTPUT_TOKENS,
  minimaxMaxOutputTokens: MINIMAX_REVIEW_OUTPUT_TOKENS,
});

type ReviewRoutingPolicyOptions = Partial<
  Pick<
    ReviewRoutingPolicy,
    | 'codexCliEnabled'
    | 'codexRepoAllowed'
    | 'investigateEnabled'
    | 'riskHuntEnabled'
    | 'investigateTier'
  >
>;

export function createReviewRoutingPolicy(values: ReviewRoutingPolicyOptions): ReviewRoutingPolicy {
  const investigateTier = values.investigateTier;
  return Object.freeze({
    codexCliEnabled: values.codexCliEnabled === true,
    codexRepoAllowed: values.codexRepoAllowed ?? (() => false),
    investigateEnabled: values.investigateEnabled === true,
    riskHuntEnabled: values.riskHuntEnabled === true,
    investigateTier: ['deepseek-flash', 'deepseek', 'openai', 'standard'].includes(
      investigateTier ?? '',
    )
      ? investigateTier!
      : 'deepseek-flash',
    deepseekMaxOutputTokens: DEEPSEEK_REVIEW_OUTPUT_TOKENS,
    minimaxMaxOutputTokens: MINIMAX_REVIEW_OUTPUT_TOKENS,
  });
}

function premiumTarget(config: WorkerConfig, policy = DEFAULT_REVIEW_ROUTING_POLICY): LlmTarget {
  const api = config.llmApi;
  return {
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    api,
    transport:
      api === 'responses' ? 'responses' : api === 'anthropic' ? 'anthropic' : 'compatible-chat',
    admissionBucket: /^minimax(?:-|$)/i.test(config.llmModel) ? 'minimax' : 'premium',
    thinking: /^minimax(?:-|$)/i.test(config.llmModel),
    maxTokens: maxOutputTokensForModel(config.llmModel, policy),
  };
}

export function maxOutputTokensForModel(
  model: string,
  policy: ReviewRoutingPolicy = DEFAULT_REVIEW_ROUTING_POLICY,
): number | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes('deepseek')) return policy.deepseekMaxOutputTokens;
  if (normalized.includes('minimax')) return policy.minimaxMaxOutputTokens;
  return undefined;
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
  return {
    ...common,
    related: context.related,
    dependents: context.dependents,
    others: context.others,
  };
}

export function canRunCodexCli(
  plan: { modelTier?: ModelTier },
  policy: ReviewRoutingPolicy = DEFAULT_REVIEW_ROUTING_POLICY,
): boolean {
  return (
    policy.codexCliEnabled &&
    (plan.modelTier === 'codex-hybrid' || plan.modelTier === 'multi-model')
  );
}

export function canRunAgentic(
  plan: { modelTier?: ModelTier },
  repoId: string,
  policy: ReviewRoutingPolicy = DEFAULT_REVIEW_ROUTING_POLICY,
): boolean {
  if (!canRunCodexCli(plan, policy)) return false;
  return policy.codexRepoAllowed(repoId);
}

export function canRunInvestigate(
  plan: { id?: string; modelTier?: ModelTier },
  opts: { useCodexCli: boolean },
  policy: ReviewRoutingPolicy = DEFAULT_REVIEW_ROUTING_POLICY,
): boolean {
  if (!policy.investigateEnabled || opts.useCodexCli) return false;
  return plan.modelTier === 'multi-model' || plan.modelTier === 'codex-hybrid';
}

export function canRunRiskHunt(
  plan: { modelTier?: ModelTier },
  opts: { highRisk: boolean; hasFlash: boolean },
  policy: ReviewRoutingPolicy = DEFAULT_REVIEW_ROUTING_POLICY,
): boolean {
  if (!policy.riskHuntEnabled || !opts.highRisk || !opts.hasFlash) return false;
  return (
    plan.modelTier === 'dual-model' ||
    plan.modelTier === 'multi-model' ||
    plan.modelTier === 'codex-hybrid'
  );
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
  policy: ReviewRoutingPolicy = DEFAULT_REVIEW_ROUTING_POLICY,
): { target: LlmTarget; tier: PassTier } {
  const override = policy.investigateTier;
  if (override === 'openai' && config.openaiModel)
    return { target: config.openaiModel, tier: 'openai' };
  if (override === 'deepseek' && config.deepseekModel)
    return { target: config.deepseekModel, tier: 'deepseek' };
  if (override === 'standard') return { target: config.standardModel, tier: 'standard' };
  if (config.deepseekFlashModel)
    return { target: config.deepseekFlashModel, tier: 'deepseek-flash' };
  if (config.deepseekModel) return { target: config.deepseekModel, tier: 'deepseek' };
  if (config.openaiModel) return { target: config.openaiModel, tier: 'openai' };
  return { target: config.standardModel, tier: 'standard' };
}

export function modelForPass(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
  passIndex: number,
  agentic = false,
  policy: ReviewRoutingPolicy = DEFAULT_REVIEW_ROUTING_POLICY,
): { target: LlmTarget; tier: PassTier } {
  if (compileReviewPlan(plan.modelTier)) {
    throw new Error('public review plans must resolve through ProviderCatalog');
  }

  if (plan.modelTier === 'codex-hybrid') {
    if (passIndex === 0 && config.codexCliModel && agentic) {
      return { target: config.codexCliModel, tier: 'openai' };
    }
    if (passIndex === 0)
      throw new Error(
        'high-tier Luna requires the pinned Codex CLI; direct API substitution is disabled',
      );
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
      : { target: premiumTarget(config, policy), tier: 'premium' };
  }
  if (plan.modelTier === 'standard') return { target: config.standardModel, tier: 'standard' };
  return { target: premiumTarget(config, policy), tier: 'premium' };
}

export function modelForPlanWithTier(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
): { target: LlmTarget; tier: PassTier } {
  if (compileReviewPlan(plan.modelTier)) {
    throw new Error('public review plans must resolve through ProviderCatalog');
  }

  if (plan.modelTier === 'codex-hybrid') {
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
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== 'api.openai.com' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/, '') !== '/v1'
  ) {
    throw new Error(
      'direct Luna configuration must use https://api.openai.com/v1; gateways and custom paths are refused',
    );
  }
  if (api !== undefined && api !== '' && api !== 'responses') {
    throw new Error(
      'direct Luna configuration must use the OpenAI Responses API, not chat/completions',
    );
  }
  return 'https://api.openai.com/v1';
}

export function hasPinnedCodexLuna(
  config: WorkerConfig,
  plan: { modelTier?: ModelTier },
  repoId: string | undefined,
  policy: ReviewRoutingPolicy = DEFAULT_REVIEW_ROUTING_POLICY,
): boolean {
  return Boolean(
    repoId &&
      canRunAgentic(plan, repoId, policy) &&
      config.codexCliModel?.model.trim().toLowerCase() === DEFAULT_CODEX_CLI_MODEL,
  );
}
