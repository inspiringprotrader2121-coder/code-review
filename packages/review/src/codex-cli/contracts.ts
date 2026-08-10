import type { LlmAttemptEvent } from '../llm-client.js';
import type { ReviewPromptContext } from '../prompt.js';
import type { LlmReviewResponse } from '../types.js';
import type { ProviderDependencies } from '../providers/types.js';

/** How much repository context is included in the opening Codex turn. */
export type CodexPromptMode = 'full' | 'lean' | 'slim';

export interface CodexCliReviewOptions {
  threadId?: string;
  /** Ignored in production: Luna is deliberately pinned by the adapter. */
  model?: string;
  /** Ignored in production: max reasoning is deliberately pinned by the adapter. */
  reasoningEffort?: string;
  signal?: AbortSignal;
  context?: ReviewPromptContext;
  cwd?: string;
  repoId?: string;
  promptMode?: CodexPromptMode;
  onUsage?: (usage: {
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    model?: string;
    provider?: string;
    attemptId?: string;
  }) => void;
  onAttempt?: (event: LlmAttemptEvent) => void;
  /** Adapter-only seams; production uses the internal container runtime. */
  dependencies?: Pick<
    ProviderDependencies,
    'admission' | 'retryPolicy' | 'clock' | 'spawn' | 'codexContainer' | 'attemptObserver'
  >;
}

export interface CodexCliReviewResult {
  response: LlmReviewResponse;
  threadId: string;
}

export const DEFAULT_CODEX_CLI_MODEL = 'gpt-5.6-luna';
export const DEFAULT_CODEX_CLI_REASONING_EFFORT = 'max';

export type CodexAuthMode = 'apikey' | 'oauth' | 'unknown';

export interface CodexExecArgsOptions {
  model: string;
  reasoningEffort?: string;
  threadId?: string;
  cwd: string;
  lastMessageFile: string;
  outerSandboxed?: boolean;
}

export type CodexChildListener = {
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
};
