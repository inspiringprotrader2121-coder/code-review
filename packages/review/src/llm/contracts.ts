import type {
  Clock,
  JsonSchemaContract,
  ModelAttemptEvent,
  ModelAttemptLineage,
  ModelAttemptOutcome,
  ProviderAdmission,
  ProviderDependencies,
} from '../providers/types.js';
import type { JsonContractKey } from './parsing.js';

export type LlmAttemptOutcome = ModelAttemptOutcome;
export type LlmAttemptEvent = ModelAttemptEvent;

/** Structural interface implemented by the Redis queue in production. */
export interface LlmProviderCoordinator extends ProviderAdmission {}

/** Injectable seams used by provider adapters; legacy callers keep production defaults. */
export interface LlmClientDependencies
  extends Pick<
    ProviderDependencies,
    'admission' | 'retryPolicy' | 'clock' | 'http' | 'attemptObserver'
  > {
  /** Test seam for Anthropic/MiniMax streams; production constructs the SDK client. */
  anthropic?: {
    messages: {
      stream(params: Record<string, unknown>): {
        finalMessage(): Promise<{
          content: Array<{ type: string; text?: string; thinking?: string }>;
          stop_reason?: string | null;
          usage?: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        }>;
        abort(): void;
        on(event: 'streamEvent', listener: () => void): unknown;
        off?(event: 'streamEvent', listener: () => void): unknown;
      };
    };
  };
}

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
  /** Internal state for a bounded answer-only prefix continuation. */
  compatibleContinuation?: {
    reasoningContent: string;
    contentPrefix: string;
  };
  /**
   * Seed used only to finish truncated JSON. Empty string disables guessed
   * prefixes; complete objects must not be rewritten into a different contract.
   */
  jsonContractPrefix?: string;
  /** Accepted top-level keys for a valid JSON response contract. */
  jsonContractKeys?: readonly JsonContractKey[];
  /** Strict structured-output contract for Responses API providers. */
  jsonSchema?: JsonSchemaContract;
  /** Internal per-request wall cap; public review calls use the configured LLM max-total cap. */
  hardLimitMs?: number;
  /**
   * Last provider stop/finish reason for this attempt. Transports write this
   * so structured-output recovery can distinguish truncation from completion.
   */
  generationStopReason?: string | null;
  dependencies?: LlmClientDependencies;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};
