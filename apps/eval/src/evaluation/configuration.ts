import { createHash } from 'node:crypto';
import {
  buildReviewPassAngles,
  HIGH_TIER_FLASH_FOCUS,
  maxRiskProbes,
  THIRD_ANGLE_FOCUS,
  type ReviewFinding,
} from '@orvex-review/review';
import type { EvaluationPass, PassTarget } from './types.js';

function configuredApi(
  env: NodeJS.ProcessEnv,
  variable: 'ORVEX_STANDARD_API' | 'MINIMAX_API',
  baseUrl: string,
): NonNullable<PassTarget['api']> {
  const configured = env[variable];
  if (configured === 'anthropic' || configured === 'responses' || configured === 'chat')
    return configured;
  return baseUrl.includes('/anthropic') ? 'anthropic' : 'chat';
}

function standardTarget(env: NodeJS.ProcessEnv): PassTarget {
  const stdKey = env.ORVEX_STANDARD_API_KEY;
  const minimax = env.MINIMAX_API_KEY;
  const anthropic = env.ANTHROPIC_API_KEY;
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
  if (!anthropic)
    throw new Error('ORVEX_STANDARD_API_KEY, MINIMAX_API_KEY or ANTHROPIC_API_KEY required');
  return {
    apiKey: anthropic,
    baseUrl: undefined,
    model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
  };
}

function openAiTarget(env: NodeJS.ProcessEnv): PassTarget | null {
  const apiKey = env.ORVEX_OPENAI_API_KEY;
  return apiKey
    ? {
        apiKey,
        baseUrl: env.ORVEX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: env.ORVEX_OPENAI_MODEL ?? 'gpt-5.6-luna',
        api: env.ORVEX_OPENAI_API === 'chat' ? 'chat' : 'responses',
        reasoningEffort: 'max',
      }
    : null;
}

function deepseekTarget(env: NodeJS.ProcessEnv, flash: boolean): PassTarget | null {
  const apiKey = env.ORVEX_DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    model: flash
      ? (env.ORVEX_DEEPSEEK_FLASH_MODEL ?? 'deepseek-v4-flash')
      : (env.ORVEX_DEEPSEEK_MODEL ?? 'deepseek-v4-pro'),
    reasoningEffort: 'max',
  };
}

export function evaluationVerifier(env: NodeJS.ProcessEnv = process.env): {
  target: PassTarget;
  tier: ReviewFinding['sourceTier'];
} {
  const target = deepseekTarget(env, true);
  if (!target)
    throw new Error('ORVEX_DEEPSEEK_API_KEY is required for the Flash verification stage');
  return { target, tier: 'deepseek-flash' };
}

/** Mirrors production's fixed high-tier lineup and conditional pass angles. */
export function evaluationPassTargets(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    deep?: boolean;
    files?: ReadonlyArray<{
      filename?: string;
      patch?: string | null;
      status?: string;
      previous_filename?: string | null;
      previousFilename?: string | null;
    }>;
  } = {},
): EvaluationPass[] {
  const standard = standardTarget(env);
  const openai = openAiTarget(env);
  const flash = deepseekTarget(env, true);
  if (!openai) throw new Error('ORVEX_OPENAI_API_KEY is required for the Luna review stage');
  if (!flash)
    throw new Error('ORVEX_DEEPSEEK_API_KEY is required for the DeepSeek v4 Flash review stages');
  const catalog: EvaluationPass[] = [
    { tag: 'general', target: openai, tier: 'openai' },
    { tag: 'deep-dive', target: flash, focus: HIGH_TIER_FLASH_FOCUS, tier: 'deepseek-flash' },
    {
      tag: 'perf/completeness/api',
      target: standard,
      focus: THIRD_ANGLE_FOCUS,
      tier: 'standard',
      bestEffort: true,
    },
  ];
  const wanted =
    opts.files === undefined
      ? null
      : new Set(
          buildReviewPassAngles({
            modelTier: 'multi-model',
            deep: opts.deep,
            files: opts.files,
          }).map((angle) => angle.tag),
        );
  return wanted ? catalog.filter((pass) => wanted.has(pass.tag)) : catalog;
}

export function evaluationInvestigateTarget(env: NodeJS.ProcessEnv = process.env): {
  target: PassTarget;
  tier: ReviewFinding['sourceTier'];
} | null {
  const override = (env.ORVEX_INVESTIGATE_TIER ?? 'deepseek-flash').trim().toLowerCase();
  const openai = openAiTarget(env);
  const deepseek = deepseekTarget(env, false);
  const flash = deepseekTarget(env, true);
  const standard = (() => {
    try {
      return standardTarget(env);
    } catch {
      return null;
    }
  })();
  if (override === 'openai' && openai) return { target: openai, tier: 'openai' };
  if (override === 'deepseek' && deepseek) return { target: deepseek, tier: 'deepseek' };
  if (override === 'standard' && standard) return { target: standard, tier: 'standard' };
  if (flash) return { target: flash, tier: 'deepseek-flash' };
  if (deepseek) return { target: deepseek, tier: 'deepseek' };
  if (openai) return { target: openai, tier: 'openai' };
  return standard ? { target: standard, tier: 'standard' } : null;
}

export function evaluationInvestigateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORVEX_INVESTIGATE === '1' && evaluationInvestigateTarget(env) !== null;
}

export function evaluationRiskHuntTarget(env: NodeJS.ProcessEnv = process.env): {
  target: PassTarget;
  tier: ReviewFinding['sourceTier'];
} | null {
  if (env.ORVEX_RISK_HUNT !== '1') return null;
  const target = deepseekTarget(env, true);
  return target ? { target, tier: 'deepseek-flash' } : null;
}

export function evaluationMaxRiskProbes(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.ORVEX_RISK_PROBES);
  return Number.isFinite(override) && override >= 0
    ? Math.min(4, Math.floor(override))
    : maxRiskProbes({ modelTier: 'multi-model' });
}

export function evaluationModelConfiguration(env: NodeJS.ProcessEnv = process.env): {
  schemaVersion: 1;
  execution: 'controlled-live';
  lunaExecution: {
    transport: 'direct-responses-api';
    productionTransport: 'containerized-codex-cli';
    productionEquivalent: false;
  };
  claimScope: 'non-production-transport';
  passes: Array<{
    tag: string;
    model: string;
    api: string;
    reasoningEffort: string | null;
    tier: string | null;
    bestEffort: boolean;
  }>;
  verifier: { model: string; api: string; reasoningEffort: string | null; tier: string | null };
  normalSurface: 'partitionVerifiedFindings.toPost';
  manualSurface: 'partitionVerifiedFindings.reviewOnly';
} {
  const api = (target: PassTarget) => target.api ?? (target.baseUrl ? 'chat' : 'anthropic');
  const passes = evaluationPassTargets(env).map((pass) => ({
    tag: pass.tag,
    model: pass.target.model,
    api: api(pass.target),
    reasoningEffort: pass.target.reasoningEffort ?? null,
    tier: pass.tier ?? null,
    bestEffort: Boolean(pass.bestEffort),
  }));
  const verifier = evaluationVerifier(env);
  return {
    schemaVersion: 1,
    execution: 'controlled-live',
    lunaExecution: {
      transport: 'direct-responses-api',
      productionTransport: 'containerized-codex-cli',
      productionEquivalent: false,
    },
    claimScope: 'non-production-transport',
    passes,
    verifier: {
      model: verifier.target.model,
      api: api(verifier.target),
      reasoningEffort: verifier.target.reasoningEffort ?? null,
      tier: verifier.tier ?? null,
    },
    normalSurface: 'partitionVerifiedFindings.toPost',
    manualSurface: 'partitionVerifiedFindings.reviewOnly',
  };
}

export function evaluationConfigurationFingerprint(
  configuration: ReturnType<typeof evaluationModelConfiguration>,
): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}
