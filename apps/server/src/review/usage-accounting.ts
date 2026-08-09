import { randomUUID } from 'node:crypto';
import type { LlmTarget, PassTier, WorkerConfig } from './worker-types.js';

function positiveEnvNumber(name: string, fallback: number, max = 1_000_000): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

const COST_RATES: Record<PassTier, { input: number; output: number }> = {
  premium: {
    input: positiveEnvNumber('ORVEX_COST_INPUT_PER_M', 1.4),
    output: positiveEnvNumber('ORVEX_COST_OUTPUT_PER_M', 4.4),
  },
  standard: {
    input: positiveEnvNumber('ORVEX_STANDARD_COST_INPUT_PER_M', 0.3),
    output: positiveEnvNumber('ORVEX_STANDARD_COST_OUTPUT_PER_M', 1.2),
  },
  openai: {
    input: positiveEnvNumber('ORVEX_OPENAI_COST_INPUT_PER_M', 0.2),
    output: positiveEnvNumber('ORVEX_OPENAI_COST_OUTPUT_PER_M', 1.2),
  },
  deepseek: {
    input: positiveEnvNumber('ORVEX_DEEPSEEK_COST_INPUT_PER_M', 0.435),
    output: positiveEnvNumber('ORVEX_DEEPSEEK_COST_OUTPUT_PER_M', 0.87),
  },
  'deepseek-flash': {
    input: positiveEnvNumber('ORVEX_DEEPSEEK_FLASH_COST_INPUT_PER_M', 0.14),
    output: positiveEnvNumber('ORVEX_DEEPSEEK_FLASH_COST_OUTPUT_PER_M', 0.28),
  },
};

export function computeCostUsd(inputTokens: number, outputTokens: number, tier: PassTier): number {
  const safeInput = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeOutput = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const rates = COST_RATES[tier];
  return (safeInput / 1e6) * rates.input + (safeOutput / 1e6) * rates.output;
}

export function actualPassTier(fallback: PassTier, model: string, provider: string): PassTier {
  const identity = `${provider} ${model}`.toLowerCase();
  if (identity.includes('deepseek-v4-flash') || identity.includes('deepseek-flash')) return 'deepseek-flash';
  if (identity.includes('deepseek')) return 'deepseek';
  if (/\b(gpt|luna|codex|openai)\b/.test(identity)) return 'openai';
  if (identity.includes('minimax') || identity.includes('standard')) return 'standard';
  if (identity.includes('anthropic') || identity.includes('claude') || identity.includes('glm')) return 'premium';
  return fallback;
}

export function usageProvider(target: LlmTarget, passName: string): string {
  if (passName.toLowerCase().includes('codex')) return 'codex-cli';
  if (target.api === 'anthropic') return 'anthropic';
  if (!target.baseUrl && target.api !== 'responses' && target.api !== 'chat') return 'anthropic';
  if (!target.baseUrl) return 'openai';
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
): AccountedUsage {
  const provider = usage.provider ?? usageProvider(target, passName);
  const model = usage.model ?? target.model;
  const tier = actualPassTier(fallbackTier, model, provider);
  const rates = COST_RATES[tier];
  const inputTokens = Number.isFinite(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) && usage.outputTokens > 0 ? usage.outputTokens : 0;
  return {
    ...usage,
    inputTokens,
    outputTokens,
    provider,
    model,
    tier,
    inputRatePerM: rates.input,
    outputRatePerM: rates.output,
    costUsd: computeCostUsd(inputTokens, outputTokens, tier),
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
): (usage: UsageEvent) => void {
  return (usage) => {
    const accounted = accountUsage(fallbackTier, target, passName, usage);
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
): { inputTokens: number; outputTokens: number; costUsd: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const [tier, item] of Object.entries(usage) as Array<[PassTier, { in: number; out: number }]>) {
    inputTokens += item.in;
    outputTokens += item.out;
    costUsd += computeCostUsd(item.in, item.out, tier);
  }
  return { inputTokens, outputTokens, costUsd };
}
