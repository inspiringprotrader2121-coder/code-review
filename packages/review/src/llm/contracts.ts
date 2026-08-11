import type {
  Clock,
  ModelAttemptEvent,
  ModelAttemptLineage,
  ModelAttemptOutcome,
  ProviderAdmission,
  ProviderDependencies,
} from '../providers/types.js';

export type LlmAttemptOutcome = ModelAttemptOutcome;
export type LlmAttemptEvent = ModelAttemptEvent;

/** Structural interface implemented by the Redis queue in production. */
export interface LlmProviderCoordinator extends ProviderAdmission {}

/** Injectable seams used by provider adapters; legacy callers keep production defaults. */
export interface LlmClientDependencies
  extends Pick<
    ProviderDependencies,
    'admission' | 'retryPolicy' | 'clock' | 'http' | 'attemptObserver'
  > {}

export interface LlmClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  json?: boolean;
  thinking?: boolean;
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
  temperature?: number;
  signal?: AbortSignal;
  onUsage?: (usage: {
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    provider?: string;
    model?: string;
    attemptId?: string;
  }) => void;
  onAttempt?: (event: LlmAttemptEvent) => void;
  /** Shared only by explicit semantic retries so durable attempts retain lineage. */
  attemptLineage?: ModelAttemptLineage;
  /** Internal state for a bounded DeepSeek thinking-mode prefix continuation. */
  compatibleContinuation?: {
    reasoningContent: string;
    contentPrefix: string;
  };
  /** Internal per-request wall cap; public review calls use the configured 300s cap. */
  hardLimitMs?: number;
  dependencies?: LlmClientDependencies;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};
