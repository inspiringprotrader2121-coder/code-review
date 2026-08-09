import { randomUUID } from 'node:crypto';
import type { LlmTarget, PassTier, WorkerConfig } from './worker-types.js';

export type UsageCostPolicy = Record<PassTier, { input: number; output: number }>;

export const DEFAULT_USAGE_COST_POLICY: UsageCostPolicy = {
  premium: { input: 1.4, output: 4.4 },
  standard: { input: 0.3, output: 1.2 },
  openai: { input: 0.2, output: 1.2 },
  deepseek: { input: 0.435, output: 0.87 },
  'deepseek-flash': { input: 0.14, output: 0.28 },
};

export function createUsageCostPolicy(
  values: Partial<Record<PassTier, Partial<{ input: number; output: number }>>>,
): UsageCostPolicy {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) && Number(value) > 0 ? Math.min(Number(value), 1_000_000) : fallback;
  return Object.fromEntries(
    (Object.keys(DEFAULT_USAGE_COST_POLICY) as PassTier[]).map((tier) => [
      tier,
      {
        input: positive(values[tier]?.input, DEFAULT_USAGE_COST_POLICY[tier].input),
        output: positive(values[tier]?.output, DEFAULT_USAGE_COST_POLICY[tier].output),
      },
    ]),
  ) as UsageCostPolicy;
}

export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  tier: PassTier,
  policy: UsageCostPolicy = DEFAULT_USAGE_COST_POLICY,
): number {
  const safeInput = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeOutput = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const rates = policy[tier];
  return (safeInput / 1e6) * rates.input + (safeOutput / 1e6) * rates.output;
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
  outputTokens: number;
  tokenSource?: 'provider' | 'estimate';
  model?: string;
  provider?: string;
}

export interface AccountedUsage extends UsageEvent {
  provider: string;
  model: string;
  tier: PassTier;
  inputRatePerM: number;
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
  const rates = policy[tier];
  const inputTokens =
    Number.isFinite(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : 0;
  const outputTokens =
    Number.isFinite(usage.outputTokens) && usage.outputTokens > 0 ? usage.outputTokens : 0;
  return {
    ...usage,
    inputTokens,
    outputTokens,
    provider,
    model,
    tier,
    inputRatePerM: rates.input,
    outputRatePerM: rates.output,
    costUsd: computeCostUsd(inputTokens, outputTokens, tier, policy),
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
      outputTokens: accounted.outputTokens,
      inputRatePerM: accounted.inputRatePerM,
      outputRatePerM: accounted.outputRatePerM,
      costUsd: accounted.costUsd,
      tokenSource: accounted.tokenSource ?? 'unknown',
      attemptId,
    });
  };
}

export type TierUsage = Record<PassTier, { in: number; out: number }>;

export function totalUsage(
  usage: TierUsage,
  policy: UsageCostPolicy = DEFAULT_USAGE_COST_POLICY,
): { inputTokens: number; outputTokens: number; costUsd: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const [tier, item] of Object.entries(usage) as Array<
    [PassTier, { in: number; out: number }]
  >) {
    inputTokens += item.in;
    outputTokens += item.out;
    costUsd += computeCostUsd(item.in, item.out, tier, policy);
  }
  return { inputTokens, outputTokens, costUsd };
}
