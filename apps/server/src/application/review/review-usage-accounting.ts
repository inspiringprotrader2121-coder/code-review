import type { LlmAttemptEvent } from '@orvex-review/review';
import type { LlmTarget, PassTier } from '../../review/worker-types.js';
import {
  accountUsage,
  type TierUsage,
  type UsageCostPolicy,
} from '../../review/usage-accounting.js';

export interface ReviewAttemptStore {
  recordReviewRunUsage(input: {
    runId: string;
    tenantId: string;
    provider: string;
    model: string;
    tier: PassTier;
    passName: string;
    inputTokens: number;
    outputTokens: number;
    inputRatePerM: number;
    outputRatePerM: number;
    costUsd: number;
    tokenSource: 'provider' | 'estimate';
    attemptId?: string;
  }): unknown;
  startReviewRunAttempt(input: {
    id: string;
    runId: string;
    tenantId: string;
    parentAttemptId?: string;
    provider: string;
    model: string;
    tier: PassTier;
    passName: string;
    transport: 'responses' | 'chat' | 'anthropic' | 'codex-cli';
    retryIndex: number;
    keyIndex: number;
    startedAt: string;
  }): boolean;
  completeReviewRunAttempt(input: {
    id: string;
    outcome: string;
    durationMs: number;
    completedAt: string;
    error?: string;
  }): boolean;
}

export interface ReviewUsageAccountingDependencies {
  store: ReviewAttemptStore;
  runId?: string;
  tenantId: string;
  policy: UsageCostPolicy;
  onOwnershipLoss: () => void;
}

export interface ReviewUsageAccounting {
  usage: TierUsage;
  onUsageFor(
    tier: PassTier,
    target: LlmTarget,
    passName: string,
  ): (usage: {
    inputTokens: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    model?: string;
    attemptId?: string;
    provider?: string;
  }) => void;
  onAttemptFor(tier: PassTier, passName: string): (event: LlmAttemptEvent) => void;
}

/** Records durable provider lifecycle and cost data without exposing a database facade to providers. */
export function createReviewUsageAccounting(
  dependencies: ReviewUsageAccountingDependencies,
): ReviewUsageAccounting {
  const usage: TierUsage = {
    standard: { in: 0, out: 0 },
    premium: { in: 0, out: 0 },
    openai: { in: 0, out: 0 },
    deepseek: { in: 0, out: 0 },
    'deepseek-flash': { in: 0, out: 0 },
  };
  const onUsageFor =
    (tier: PassTier, target: LlmTarget, passName: string) =>
    (reported: {
      inputTokens: number;
      outputTokens: number;
      tokenSource?: 'provider' | 'estimate';
      model?: string;
      attemptId?: string;
      provider?: string;
    }) => {
      const accounted = accountUsage(tier, target, passName, reported, dependencies.policy);
      usage[accounted.tier].in += accounted.inputTokens;
      usage[accounted.tier].out += accounted.outputTokens;
      if (!dependencies.runId) return;
      const recorded = dependencies.store.recordReviewRunUsage({
        runId: dependencies.runId,
        tenantId: dependencies.tenantId,
        provider: accounted.provider,
        model: accounted.model,
        tier: accounted.tier,
        passName,
        inputTokens: accounted.inputTokens,
        outputTokens: accounted.outputTokens,
        inputRatePerM: accounted.inputRatePerM,
        outputRatePerM: accounted.outputRatePerM,
        costUsd: accounted.costUsd,
        tokenSource:
          reported.tokenSource ??
          (target.transport === 'compatible-chat' ? 'estimate' : 'provider'),
        attemptId: reported.attemptId,
      });
      if (!recorded) dependencies.onOwnershipLoss();
    };
  const onAttemptFor = (tier: PassTier, passName: string) => (event: LlmAttemptEvent) => {
    if (!dependencies.runId) return;
    if (event.phase === 'started') {
      const started = dependencies.store.startReviewRunAttempt({
        id: event.attemptId,
        runId: dependencies.runId,
        tenantId: dependencies.tenantId,
        parentAttemptId: event.parentAttemptId,
        provider: event.provider,
        model: event.model,
        tier,
        passName,
        transport: event.transport,
        retryIndex: event.retryIndex,
        keyIndex: event.keyIndex,
        startedAt: event.startedAt,
      });
      if (!started) dependencies.onOwnershipLoss();
      return;
    }
    const completed = dependencies.store.completeReviewRunAttempt({
      id: event.attemptId,
      outcome: event.outcome,
      durationMs: event.durationMs,
      completedAt: event.completedAt,
      error: event.error,
    });
    if (!completed) dependencies.onOwnershipLoss();
  };
  return { usage, onUsageFor, onAttemptFor };
}
