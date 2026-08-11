import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';

/** Provider transport is part of the review-stage contract, never guessed by an adapter. */
export type ModelTransport = 'responses' | 'compatible-chat' | 'anthropic' | 'codex-cli';
/** Stable durable attempt value retained for existing database/API consumers. */
export type ModelAttemptTransport = 'responses' | 'chat' | 'anthropic' | 'codex-cli';

export type ModelAttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'rate_limited';

export type ModelAttemptRole = 'primary' | 'retry' | 'continuation';

/** Mutable lineage shared across explicitly related provider invocations. */
export interface ModelAttemptLineage {
  lastAttemptId?: string;
  nextRetryIndex?: number;
}

export type ModelAttemptEvent =
  | {
      phase: 'started';
      attemptId: string;
      parentAttemptId?: string;
      role?: ModelAttemptRole;
      retryIndex: number;
      keyIndex: number;
      provider: string;
      model: string;
      transport: ModelAttemptTransport;
      startedAt: string;
    }
  | {
      phase: 'finished';
      attemptId: string;
      outcome: ModelAttemptOutcome;
      /** True only when provider-side work was actually started. */
      dispatched?: boolean;
      durationMs: number;
      completedAt: string;
      error?: string;
    };

export interface AttemptObserver {
  record(event: ModelAttemptEvent): void;
}

export interface ProviderAdmission {
  acquireProviderLease(provider: string, limit: number, signal?: AbortSignal): Promise<string>;
  releaseProviderLease(provider: string, token: string): Promise<void>;
  getProviderCooldownMs(provider: string): Promise<number>;
  setProviderCooldown(provider: string, durationMs: number): Promise<void>;
}

export interface RetryPolicy {
  maxAttempts: number;
  maxWaitMs: number;
  baseMs: number;
  totalWaitBudgetMs: number;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface HttpTransport {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface ProcessSpawner {
  spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams;
}

/**
 * Result of one credential-isolated Codex execution. The review package owns
 * the Codex protocol; the host application owns the local container runtime.
 * Keeping this port deliberately small prevents provider code from acquiring a
 * dependency on Docker or from smuggling host environment variables into a
 * model-controlled shell.
 */
export interface CodexContainerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The output file is written inside the service-owned checkout. */
  lastMessage: string;
  timedOut: boolean;
  inactivityTimedOut?: boolean;
  cancelled?: boolean;
  durationMs: number;
}

export interface CodexContainerRequest {
  /** Pinned CLI argv. The container runtime must not append arbitrary argv. */
  args: readonly string[];
  /** Redacted prompt written to a private file in the mounted checkout. */
  prompt: string;
  /** A service-owned, private per-review checkout mounted as /work. */
  workdir: string;
  /** Host path to the Codex last-message output within `workdir`. */
  lastMessageFile: string;
  hardTimeoutMs: number;
  inactivityTimeoutMs: number;
  signal?: AbortSignal;
}

/**
 * The only execution boundary accepted by the agentic reviewer. Production
 * implementations run the pinned CLI in Orvex's internal rootless runtime and
 * fail closed when its credential-isolating egress broker is unavailable.
 */
export interface CodexContainerRuntime {
  assertReady(signal?: AbortSignal): Promise<void>;
  run(request: CodexContainerRequest): Promise<CodexContainerResult>;
}

export interface ProviderDependencies {
  admission?: ProviderAdmission;
  retryPolicy?: RetryPolicy;
  clock?: Clock;
  http?: HttpTransport;
  spawn?: ProcessSpawner;
  codexContainer?: CodexContainerRuntime;
  attemptObserver?: AttemptObserver;
}

export interface ModelTarget {
  transport: ModelTransport;
  apiKey: string;
  model: string;
  baseUrl?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface TextModelRunRequest {
  system: string;
  user: string;
  target: ModelTarget;
  json?: boolean;
  thinking?: boolean;
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
  onAttempt?: (event: ModelAttemptEvent) => void;
  attemptLineage?: ModelAttemptLineage;
}

export interface ModelRunner<TRequest = TextModelRunRequest, TResult = string> {
  readonly transport: ModelTransport;
  run(request: TRequest): Promise<TResult>;
}
