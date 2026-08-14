import { randomUUID } from 'node:crypto';
import type { LlmTarget, PassTier, WorkerConfig } from './worker-types.js';

export interface UsageCostRates {
  input: number;
  cachedInput: number;
  cacheWrite: number;
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

/** Official DeepSeek V4 peak/off-peak card.
 * https://api-docs.deepseek.com/quick_start/pricing
 * Peak hours are 01:00–04:00 and 06:00–10:00 UTC. Off-peak is half of peak.
 * New prices take effect at 16:00 UTC on 16 Aug 2026; until then the prior
 * flat Flash/Pro rates still apply. */
export const DEEPSEEK_PEAK_OFFPEAK_EFFECTIVE_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

type DeepSeekFamily = 'flash' | 'pro';

const DEEPSEEK_LEGACY_RATES: Record<DeepSeekFamily, UsageCostRates> = {
  flash: { input: 0.14, cachedInput: 0.0028, cacheWrite: 0.14, output: 0.28 },
  pro: { input: 0.435, cachedInput: 0.003625, cacheWrite: 0.435, output: 0.87 },
};

const DEEPSEEK_OFF_PEAK_RATES: Record<DeepSeekFamily, UsageCostRates> = {
  flash: { input: 0.22, cachedInput: 0.007, cacheWrite: 0.22, output: 0.66 },
  pro: { input: 0.66, cachedInput: 0.022, cacheWrite: 0.66, output: 1.98 },
};

const DEEPSEEK_PEAK_RATES: Record<DeepSeekFamily, UsageCostRates> = {
  flash: { input: 0.44, cachedInput: 0.014, cacheWrite: 0.44, output: 1.32 },
  pro: { input: 1.32, cachedInput: 0.044, cacheWrite: 1.32, output: 3.96 },
};

export function isDeepSeekPeakUtc(at: Date): boolean {
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function publishedDeepSeekRates(
  family: DeepSeekFamily,
  at: Date = new Date(),
): UsageCostRates {
  if (at.getTime() < DEEPSEEK_PEAK_OFFPEAK_EFFECTIVE_MS) return DEEPSEEK_LEGACY_RATES[family];
  return isDeepSeekPeakUtc(at) ? DEEPSEEK_PEAK_RATES[family] : DEEPSEEK_OFF_PEAK_RATES[family];
}

function deepSeekFamilyFor(model: string, tier: PassTier): DeepSeekFamily | undefined {
  const identity = model.trim().toLowerCase();
  if (identity.includes('deepseek-v4-flash') || identity.includes('deepseek-flash')) return 'flash';
  if (identity.includes('deepseek')) return identity.includes('flash') ? 'flash' : 'pro';
  if (identity) return undefined;
  if (tier === 'deepseek-flash') return 'flash';
  if (tier === 'deepseek') return 'pro';
  return undefined;
}

export const DEFAULT_USAGE_COST_POLICY: UsageCostPolicy = {
  premium: { input: 1.4, cachedInput: 1.4, cacheWrite: 1.4, output: 4.4 },
  standard: { input: 0.3, cachedInput: 0.06, cacheWrite: 0.3, output: 1.2 },
  openai: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  deepseek: { ...DEEPSEEK_OFF_PEAK_RATES.pro },
  'deepseek-flash': { ...DEEPSEEK_OFF_PEAK_RATES.flash },
  modelRates: {
    'gpt-5.6-luna': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6 },
    'deepseek-v4-pro': { ...DEEPSEEK_OFF_PEAK_RATES.pro },
    'deepseek-v4-flash': { ...DEEPSEEK_OFF_PEAK_RATES.flash },
    'minimax-m3': { input: 0.3, cachedInput: 0.06, cacheWrite: 0.3, output: 1.2 },
  },
};

export function createUsageCostPolicy(values: UsageCostPolicyInput): UsageCostPolicy {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) && Number(value) > 0 ? Math.min(Number(value), 1_000_000) : fallback;
  const rate = (value: Partial<UsageCostRates> | undefined, fallback: UsageCostRates) => ({
    input: positive(value?.input, fallback.input),
    cachedInput: positive(value?.cachedInput, fallback.cachedInput),
    cacheWrite: positive(value?.cacheWrite, fallback.cacheWrite),
    output: positive(value?.output, fallback.output),
  });
  const tiers = Object.fromEntries(
    PASS_TIERS.map((tier) => [
      tier,
      rate(
        tier === 'deepseek' || tier === 'deepseek-flash' ? undefined : values[tier],
        DEFAULT_USAGE_COST_POLICY[tier],
      ),
    ]),
  ) as Record<PassTier, UsageCostRates>;
  const modelRates = Object.fromEntries(
    Object.entries(DEFAULT_USAGE_COST_POLICY.modelRates).map(([model, fallback]) => [
      model,
      rate(model.startsWith('deepseek-') ? undefined : values.modelRates?.[model], fallback),
    ]),
  ) as Record<string, UsageCostRates>;
  return { ...tiers, modelRates: Object.freeze(modelRates) };
}

function usageRatesFor(
  tier: PassTier,
  model: string,
  policy: UsageCostPolicy,
  inputTokens = 0,
  at: Date = new Date(),
): UsageCostRates {
  const family = deepSeekFamilyFor(model, tier);
  if (family) return publishedDeepSeekRates(family, at);
  const normalized = model.trim().toLowerCase();
  const rates = policy.modelRates[normalized] ?? policy[tier];
  // Provider pricing changes at a single-request context threshold. Usage is
  // recorded once per provider response, so this never applies a surcharge to
  // an aggregate of several smaller requests.
  const multiplier =
    (normalized === 'gpt-5.6-luna' && inputTokens > 272_000) ||
    (normalized === 'minimax-m3' && inputTokens > 512_000)
      ? { input: 2, cachedInput: 2, cacheWrite: 2, output: normalized === 'gpt-5.6-luna' ? 1.5 : 2 }
      : undefined;
  if (!multiplier) return rates;
  return {
    input: rates.input * multiplier.input,
    cachedInput: rates.cachedInput * multiplier.cachedInput,
    cacheWrite: rates.cacheWrite * multiplier.cacheWrite,
    output: rates.output * multiplier.output,
  };
}

export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  tier: PassTier,
  policy: UsageCostPolicy = DEFAULT_USAGE_COST_POLICY,
  cachedInputTokens = 0,
  model?: string,
  cacheWriteTokens = 0,
  at: Date = new Date(),
): number {
  const safeInput = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeOutput = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  const safeCachedInput = Math.min(
    safeInput,
    Number.isFinite(cachedInputTokens) && cachedInputTokens > 0 ? cachedInputTokens : 0,
  );
  const safeCacheWrite = Math.min(
    safeInput - safeCachedInput,
    Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0 ? cacheWriteTokens : 0,
  );
  const rates = usageRatesFor(tier, model ?? '', policy, safeInput, at);
  return (
    ((safeInput - safeCachedInput - safeCacheWrite) / 1e6) * rates.input +
    (safeCachedInput / 1e6) * rates.cachedInput +
    (safeCacheWrite / 1e6) * rates.cacheWrite +
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
  cacheWriteTokens?: number;
  outputTokens: number;
  tokenSource?: 'provider' | 'estimate';
  model?: string;
  provider?: string;
}

export interface AccountedUsage extends Omit<UsageEvent, 'cachedInputTokens' | 'cacheWriteTokens'> {
  cachedInputTokens: number;
  cacheWriteTokens: number;
  provider: string;
  model: string;
  tier: PassTier;
  inputRatePerM: number;
  cachedInputRatePerM: number;
  cacheWriteRatePerM: number;
  outputRatePerM: number;
  costUsd: number;
}

export function accountUsage(
  fallbackTier: PassTier,
  target: LlmTarget,
  passName: string,
  usage: UsageEvent,
  policy: UsageCostPolicy = DEFAULT_USAGE_COST_POLICY,
  at: Date = new Date(),
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
  const cacheWriteTokens = Math.min(
    inputTokens - cachedInputTokens,
    Number.isFinite(usage.cacheWriteTokens) && usage.cacheWriteTokens! > 0
      ? usage.cacheWriteTokens!
      : 0,
  );
  const rates = usageRatesFor(tier, model, policy, inputTokens, at);
  return {
    ...usage,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    provider,
    model,
    tier,
    inputRatePerM: rates.input,
    cachedInputRatePerM: rates.cachedInput,
    cacheWriteRatePerM: rates.cacheWrite,
    outputRatePerM: rates.output,
    costUsd: computeCostUsd(
      inputTokens,
      outputTokens,
      tier,
      policy,
      cachedInputTokens,
      model,
      cacheWriteTokens,
      at,
    ),
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
      cacheWriteTokens: accounted.cacheWriteTokens,
      outputTokens: accounted.outputTokens,
      inputRatePerM: accounted.inputRatePerM,
      cachedInputRatePerM: accounted.cachedInputRatePerM,
      cacheWriteRatePerM: accounted.cacheWriteRatePerM,
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
