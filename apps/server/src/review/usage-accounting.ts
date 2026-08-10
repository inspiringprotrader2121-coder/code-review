import { randomUUID } from 'node:crypto';
import type { LlmTarget, PassTier, WorkerConfig } from './worker-types.js';

export interface UsageCostRates {
  input: number;
  cachedInput: number;
  output: number;
}

export type UsageCostPolicy = Record<PassTier, UsageCostRates> & {
  modelRates: Readonly<Record<string, UsageCostRates>>;
};

export type UsageCostPolicyInput = Partial<Record<PassTier, Partial<UsageCostRates>>> & {
  modelRates?: Readonly<Record<string, Partial<UsageCostRates>>>;
};

const PASS_TIERS: readonly PassTier[] = [
  'premium',
  'standard',
  'openai',
  'deepseek',
  'deepseek-flash',
];

export const DEFAULT_USAGE_COST_POLICY: UsageCostPolicy = {
  premium: { input: 1.4, cachedInput: 1.4, output: 4.4 },
  standard: { input: 0.3, cachedInput: 0.06, output: 1.2 },
  openai: { input: 1, cachedInput: 0.1, output: 6 },
  deepseek: { input: 0.435, cachedInput: 0.003625, output: 0.87 },
  'deepseek-flash': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  modelRates: {
    'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
    'deepseek-v4-pro': { input: 0.435, cachedInput: 0.003625, output: 0.87 },
    'deepseek-v4-flash': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
    'minimax-m3': { input: 0.3, cachedInput: 0.06, output: 1.2 },
  },
};

export function createUsageCostPolicy(values: UsageCostPolicyInput): UsageCostPolicy {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) && Number(value) > 0 ? Math.min(Number(value), 1_000_000) : fallback;
  const rate = (value: Partial<UsageCostRates> | undefined, fallback: UsageCostRates) => ({
    input: positive(value?.input, fallback.input),
    cachedInput: positive(value?.cachedInput, fallback.cachedInput),
    output: positive(value?.output, fallback.output),
  });
  const tiers = Object.fromEntries(
    PASS_TIERS.map((tier) => [tier, rate(values[tier], DEFAULT_USAGE_COST_POLICY[tier])]),
  ) as Record<PassTier, UsageCostRates>;
  const modelRates = Object.fromEntries(
    Object.entries(DEFAULT_USAGE_COST_POLICY.modelRates).map(([model, fallback]) => [
      model,
      rate(values.modelRates?.[model], fallback),
    ]),
  ) as Record<string, UsageCostRates>;
  return { ...tiers, modelRates: Object.freeze(modelRates) };
}

function usageRatesFor(tier: PassTier, model: string, policy: UsageCostPolicy): UsageCostRates {
  return policy.modelRates[model.trim().toLowerCase()] ?? policy[tier];
}

export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  tier: PassTier,
  policy: UsageCostPolicy = DEFAULT_USAGE_COST_POLICY,
  cachedInputTokens = 0,
  model?: string,
): number {
  const safeInput = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeOutput = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const safeCachedInput = Math.min(
    safeInput,
    Number.isFinite(cachedInputTokens) && cachedInputTokens > 0 ? cachedInputTokens : 0,
  );
  const rates = model ? usageRatesFor(tier, model, policy) : policy[tier];
  return (
    ((safeInput - safeCachedInput) / 1e6) * rates.input +
    (safeCachedInput / 1e6) * rates.cachedInput +
    (safeOutput / 1e6) * rates.output
  );
}

export function actualPassTier(fallback: PassTier, model: string, provider: string): PassTier {
  const identity = `${provider} ${model}`.toLowerCase();
  if (identity.includes('deepseek-v4-flash') || identity.includes('deepseek-flash'))
    return 'deepseek-flash';
  if (identity.includes('deepseek')) return 'deepseek';
  if (/\b(gpt|luna|codex|openai)\b/.test(identity)) return 'openai';
  if (identity.includes('minimax') || identity.includes('standard')) return 'standard';
  if (identity.includes('anthropic') || identity.includes('claude') || identity.includes('glm'))
    return 'premium';
  return fallback;
}

export function usageProvider(target: LlmTarget, passName: string): string {
  if (target.transport === 'codex-cli' || passName.toLowerCase().includes('codex'))
    return 'codex-cli';
  if (target.transport === 'anthropic') return 'anthropic';
  if (target.transport === 'responses' && !target.baseUrl) return 'openai';
  if (!target.baseUrl)
    return target.transport === 'compatible-chat' ? 'openai-compatible' : 'openai';
  try {
    return new URL(target.baseUrl).hostname;
  } catch {
    return 'openai-compatible';
  }
}

export interface UsageEvent {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  tokenSource?: 'provider' | 'estimate';
  model?: string;
  provider?: string;
}

export interface AccountedUsage extends Omit<UsageEvent, 'cachedInputTokens'> {
  cachedInputTokens: number;
  provider: string;
  model: string;
  tier: PassTier;
  inputRatePerM: number;
  cachedInputRatePerM: number;
  outputRatePerM: number;
  costUsd: number;
}

export function accountUsage(
  fallbackTier: PassTier,
  target: LlmTarget,
  passName: string,
  usage: UsageEvent,
  policy: UsageCostPolicy = DEFAULT_USAGE_COST_POLICY,
): AccountedUsage {
  const provider = usage.provider ?? usageProvider(target, passName);
  const model = usage.model ?? target.model;
  const tier = actualPassTier(fallbackTier, model, provider);
  const inputTokens =
    Number.isFinite(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : 0;
  const outputTokens =
    Number.isFinite(usage.outputTokens) && usage.outputTokens > 0 ? usage.outputTokens : 0;
  const cachedInputTokens = Math.min(
    inputTokens,
    Number.isFinite(usage.cachedInputTokens) && usage.cachedInputTokens! > 0
      ? usage.cachedInputTokens!
      : 0,
  );
  const rates = usageRatesFor(tier, model, policy);
  return {
    ...usage,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    provider,
    model,
    tier,
    inputRatePerM: rates.input,
    cachedInputRatePerM: rates.cachedInput,
    outputRatePerM: rates.output,
    costUsd: computeCostUsd(inputTokens, outputTokens, tier, policy, cachedInputTokens, model),
  };
}

export function createUsageRecorder(
  config: WorkerConfig,
  runId: string,
  tenantId: string,
  fallbackTier: PassTier,
  target: LlmTarget,
  passName: string,
  attemptId = randomUUID(),
  policy: UsageCostPolicy = DEFAULT_USAGE_COST_POLICY,
): (usage: UsageEvent) => void {
  return (usage) => {
    const accounted = accountUsage(fallbackTier, target, passName, usage, policy);
    config.store.recordReviewRunUsage({
      runId,
      tenantId,
      provider: accounted.provider,
      model: accounted.model,
      tier: accounted.tier,
      passName,
      inputTokens: accounted.inputTokens,
      cachedInputTokens: accounted.cachedInputTokens,
      outputTokens: accounted.outputTokens,
      inputRatePerM: accounted.inputRatePerM,
      cachedInputRatePerM: accounted.cachedInputRatePerM,
      outputRatePerM: accounted.outputRatePerM,
      costUsd: accounted.costUsd,
      tokenSource: accounted.tokenSource ?? 'unknown',
      attemptId,
    });
  };
}

export type TierUsage = Record<
  PassTier,
  { in: number; cachedIn: number; out: number; costUsd: number }
>;

export function totalUsage(
  usage: TierUsage,
  policy: UsageCostPolicy = DEFAULT_USAGE_COST_POLICY,
): { inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number } {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const [tier, item] of Object.entries(usage) as Array<[PassTier, TierUsage[PassTier]]>) {
    inputTokens += item.in;
    cachedInputTokens += item.cachedIn;
    outputTokens += item.out;
    costUsd += Number.isFinite(item.costUsd)
      ? item.costUsd
      : computeCostUsd(item.in, item.out, tier, policy, item.cachedIn);
  }
  return { inputTokens, cachedInputTokens, outputTokens, costUsd };
}
