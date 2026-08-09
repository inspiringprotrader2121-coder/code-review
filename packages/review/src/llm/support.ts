import { loadReviewRuntimeConfig } from '@orvex-review/config';
import type { AttemptObserver, Clock } from '../providers/types.js';
import type { LlmClientOptions } from './contracts.js';
import { systemClock } from './contracts.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const ABSOLUTE_MAX_OUTPUT_TOKENS = 1_000_000;

export function clockFor(opts: Pick<LlmClientOptions, 'dependencies'>): Clock {
  return opts.dependencies?.clock ?? systemClock;
}

export function observerFor(
  opts: Pick<LlmClientOptions, 'dependencies' | 'onAttempt'>,
): AttemptObserver | undefined {
  const observer = opts.dependencies?.attemptObserver;
  if (!observer && !opts.onAttempt) return undefined;
  return {
    record(event) {
      observer?.record(event);
      opts.onAttempt?.(event);
    },
  };
}

export function transportFor(
  opts: Pick<LlmClientOptions, 'api' | 'baseUrl'>,
): 'responses' | 'chat' | 'anthropic' {
  if (opts.api === 'responses') return 'responses';
  if (opts.api === 'anthropic' || (!opts.baseUrl && opts.api !== 'chat')) return 'anthropic';
  return 'chat';
}

export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

export function maxTotalMs(): number {
  return loadReviewRuntimeConfig().llmMaxTotalMs;
}

export function thinkingEnabled(opts: LlmClientOptions): boolean {
  return opts.thinking ?? true;
}

export function providerName(baseUrl: string | undefined, api: LlmClientOptions['api']): string {
  if (api === 'anthropic' || (!baseUrl && api !== 'responses' && api !== 'chat'))
    return 'anthropic';
  if (!baseUrl) return 'openai';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'openai-compatible';
  }
}

export function resolveMaxOutputTokens(explicit?: number): number {
  const runtime = loadReviewRuntimeConfig();
  const configured = explicit ?? runtime.maxOutputTokens;
  const valid =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const cap = Math.min(runtime.maxOutputTokensCap, ABSOLUTE_MAX_OUTPUT_TOKENS);
  if (valid > cap) {
    console.warn(
      `[llm] max_output_tokens ${valid} exceeds safe cap ${cap} — clamping. ` +
        `Oversized reservations trigger 402 "insufficient credits" and silently ` +
        `disable reasoning. Raise ORVEX_MAX_OUTPUT_TOKENS_CAP to lift the ceiling deliberately.`,
    );
  }
  return Math.min(valid, cap);
}
