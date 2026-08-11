import { randomUUID } from 'node:crypto';
import type { LlmAttemptEvent, LlmAttemptOutcome, LlmClientOptions } from './contracts.js';
import { isReviewCancelledError } from './cancellation.js';
import { clockFor, observerFor, providerName, transportFor } from './support.js';
import { isRateLimitOrQuotaError } from './retry-policy.js';
import { llmChatSingle } from './transports.js';

export interface AttemptLineage {
  lastAttemptId?: string;
}

export function attemptOutcome(error: unknown): LlmAttemptOutcome {
  if (isReviewCancelledError(error)) return 'cancelled';
  const message = (error as Error)?.message ?? String(error);
  if (/wall-clock cap|timed?\s*out|stalled/i.test(message)) return 'timed_out';
  if (isRateLimitOrQuotaError(message)) return 'rate_limited';
  return 'failed';
}

function emitAttempt(
  opts: Pick<LlmClientOptions, 'dependencies' | 'onAttempt'>,
  event: LlmAttemptEvent,
): void {
  observerFor(opts)?.record(event);
}

export function recordProviderAdmissionFailure(
  opts: LlmClientOptions,
  retryIndex: number,
  lineage: AttemptLineage,
  error: Error,
): void {
  if (!observerFor(opts)) return;
  const attemptId = randomUUID();
  const timestamp = new Date(clockFor(opts).now()).toISOString();
  emitAttempt(opts, {
    phase: 'started',
    attemptId,
    parentAttemptId: lineage.lastAttemptId,
    retryIndex,
    keyIndex: 0,
    provider: providerName(opts.baseUrl, opts.api),
    model: opts.model,
    transport: transportFor(opts),
    startedAt: timestamp,
  });
  lineage.lastAttemptId = attemptId;
  emitAttempt(opts, {
    phase: 'finished',
    attemptId,
    outcome: attemptOutcome(error),
    dispatched: false,
    error: error.message.slice(0, 2_000),
    durationMs: 0,
    completedAt: timestamp,
  });
}

export async function trackedLlmAttempt(
  system: string,
  user: string,
  opts: LlmClientOptions,
  retryIndex: number,
  keyIndex: number,
  lineage: AttemptLineage,
): Promise<string> {
  const attemptId = randomUUID();
  const clock = clockFor(opts);
  const started = clock.now();
  emitAttempt(opts, {
    phase: 'started',
    attemptId,
    parentAttemptId: lineage.lastAttemptId,
    retryIndex,
    keyIndex,
    provider: providerName(opts.baseUrl, opts.api),
    model: opts.model,
    transport: transportFor(opts),
    startedAt: new Date(started).toISOString(),
  });
  lineage.lastAttemptId = attemptId;
  try {
    const result = await llmChatSingle(system, user, {
      ...opts,
      onUsage: opts.onUsage ? (usage) => opts.onUsage?.({ ...usage, attemptId }) : undefined,
    });
    emitAttempt(opts, {
      phase: 'finished',
      attemptId,
      outcome: 'succeeded',
      dispatched: true,
      durationMs: clock.now() - started,
      completedAt: new Date(clock.now()).toISOString(),
    });
    return result;
  } catch (error) {
    emitAttempt(opts, {
      phase: 'finished',
      attemptId,
      outcome: attemptOutcome(error),
      dispatched: true,
      durationMs: clock.now() - started,
      completedAt: new Date(clock.now()).toISOString(),
      error: ((error as Error)?.message ?? String(error)).slice(0, 2_000),
    });
    throw error;
  }
}
