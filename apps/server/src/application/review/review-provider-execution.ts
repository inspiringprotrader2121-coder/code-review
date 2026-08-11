import {
  isTransientLlmError,
  llmFindingsToReviewFindings,
  REVIEW_INCOMPLETE_SUMMARY,
  runInvestigateReview,
  type LlmAttemptEvent,
  type LlmReviewResponse,
  type ReviewFinding,
} from '@orvex-review/review';
import type { ChangedFile } from '@orvex-review/github';
import type { ProviderAdapterRegistry } from '../../review/provider-registry.js';
import type { LlmTarget, PassTier } from '../../review/worker-types.js';
import type { ReviewCall } from './review-stage-scheduler.js';

export interface ReviewCallOutcome {
  ok: boolean;
  transient: boolean;
  degraded: boolean;
  summary?: string;
  findings: ReviewFinding[];
  kind: ReviewCall['kind'];
  bestEffort?: boolean;
  label?: string;
  sample: number;
  modelPassIndex?: number;
  requiredCoverageKey?: string;
}

export interface ReviewProviderExecutionInput {
  calls: ReviewCall[];
  filesForLlm: ChangedFile[];
  filesForInvestigate: ChangedFile[];
  providers: Pick<ProviderAdapterRegistry, 'runReview' | 'runCodexReview'>;
  contextRun: (
    context: ReviewCall['ctx'],
    target: LlmTarget,
    tier: PassTier,
    name: string,
    temperature?: number,
    files?: ChangedFile[],
  ) => Promise<LlmReviewResponse>;
  repoDirectory: string | null;
  repoId: string;
  signal: AbortSignal;
  isCancelled: () => boolean;
  onUsageFor: (
    tier: PassTier,
    target: LlmTarget,
    passName: string,
  ) => (usage: {
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    model?: string;
    attemptId?: string;
    provider?: string;
  }) => void;
  onAttemptFor: (tier: PassTier, passName: string) => (event: LlmAttemptEvent) => void;
  tagFindings: (findings: ReviewFinding[], tier: PassTier, passTag?: string) => void;
  mapConcurrent<T, R>(
    items: readonly T[],
    limit: number,
    run: (item: T, index: number) => Promise<R>,
  ): Promise<R[]>;
  /**
   * Redis-wide snapshot of in-flight reviews. Provider capacity is shared
   * fairly between them so one large PR can use idle capacity without starving
   * a burst of other reviews across the worker fleet.
   */
  activeReviewCount: number;
  apiConcurrency: number;
}

export function groupApiCallsByProvider(calls: ReviewCall[]): ReviewCall[][] {
  // Calls retain their provider lane for capacity accounting. Individual lanes
  // may use more than one slot when capacity is idle; see
  // `perReviewProviderParallelism` below.
  const lanes = new Map<string, ReviewCall[]>();
  for (const call of calls) {
    const key = call.target.admissionBucket;
    const lane = lanes.get(key);
    if (lane) lane.push(call);
    else lanes.set(key, [call]);
  }
  return [...lanes.values()];
}

/**
 * Divide the configured provider budget between active reviews. With one
 * review, a large PR can fan out all of its bounded chunks. At the normal
 * eight-review production ceiling, each review keeps one slot so a single PR
 * cannot monopolise the provider and make its peers time out waiting.
 */
export function perReviewProviderParallelism(
  apiConcurrency: number,
  activeReviewCount: number,
): number {
  const capacity = Math.max(1, Math.floor(apiConcurrency));
  const active = Math.max(1, Math.floor(activeReviewCount));
  return Math.max(1, Math.floor(capacity / active));
}

/**
 * Alternate lenses before advancing to later shards. This gives a high-tier
 * review its two DeepSeek perspectives promptly instead of spending every
 * available slot on one perspective's chunks first.
 */
export function interleaveProviderLane(calls: readonly ReviewCall[]): ReviewCall[] {
  const lanes = new Map<string, ReviewCall[]>();
  for (const call of calls) {
    const key = `${call.modelPassIndex ?? -1}:${call.passTag ?? ''}:${call.sample}`;
    const lane = lanes.get(key);
    if (lane) lane.push(call);
    else lanes.set(key, [call]);
  }
  const queues = [...lanes.values()].map((lane) => [...lane]);
  const interleaved: ReviewCall[] = [];
  for (;;) {
    let added = false;
    for (const queue of queues) {
      const call = queue.shift();
      if (!call) continue;
      interleaved.push(call);
      added = true;
    }
    if (!added) return interleaved;
  }
}

/** Executes independent providers in parallel while retaining Codex's ordered session lane. */
export async function executeReviewProviderCalls(
  input: ReviewProviderExecutionInput,
): Promise<ReviewCallOutcome[]> {
  const runOne = async (call: ReviewCall): Promise<ReviewCallOutcome> => {
    if (input.isCancelled()) return outcome(call, false, false, false, undefined, []);
    try {
      if (call.mode === 'agentic') {
        try {
          const { response } = await input.providers.runCodexReview(
            call.files ?? input.filesForLlm,
            call.target,
            {
              context: call.ctx,
              cwd: input.repoDirectory ?? undefined,
              repoId: input.repoId,
              signal: input.signal,
              onUsage: input.onUsageFor(call.tier, call.target, call.label),
              onAttempt: input.onAttemptFor(call.tier, call.label),
            },
          );
          const findings = llmFindingsToReviewFindings(response.findings);
          input.tagFindings(findings, call.tier, call.passTag);
          const degraded = findings.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
          console.log(
            `[worker] ${call.label}: +${findings.length} findings${degraded ? ' (degraded/unparseable)' : ''}`,
          );
          return outcome(call, !degraded, false, degraded, response.summary, findings);
        } catch (error) {
          const message = (error as Error).message;
          console.error(
            `[worker] ${call.label} Codex CLI failed; refusing substitute model/API: ${message.slice(0, 160)}`,
          );
          throw error;
        }
      }
      if (call.mode === 'investigate') {
        if (!input.repoDirectory) return outcome(call, false, false, false, undefined, []);
        const response = await runInvestigateReview(input.filesForInvestigate, {
          cwd: input.repoDirectory,
          apiKey: call.target.apiKey,
          model: call.target.model,
          baseUrl: call.target.baseUrl,
          api: call.target.api,
          reasoningEffort: call.target.reasoningEffort,
          maxTokens: call.target.maxTokens,
          context: call.ctx,
          signal: input.signal,
          onUsage: input.onUsageFor(call.tier, call.target, call.label),
          onAttempt: input.onAttemptFor(call.tier, call.label),
        });
        const findings = llmFindingsToReviewFindings(response.findings);
        input.tagFindings(findings, call.tier, call.passTag ?? 'investigate');
        const degraded = findings.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
        console.log(
          `[worker] ${call.label}: +${findings.length} findings${degraded ? ' (degraded/unparseable)' : ''}`,
        );
        return outcome(call, !degraded, false, degraded, response.summary, findings);
      }
      const response = await input.contextRun(
        call.ctx,
        call.target,
        call.tier,
        call.label,
        call.temperature,
        call.files ?? input.filesForLlm,
      );
      const findings = llmFindingsToReviewFindings(response.findings);
      input.tagFindings(findings, call.tier, call.passTag);
      const degraded = findings.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
      console.log(
        `[worker] ${call.label}: +${findings.length} findings${degraded ? ' (degraded/unparseable)' : ''}`,
      );
      return outcome(call, !degraded, false, degraded, response.summary, findings);
    } catch (error) {
      const message = (error as Error).message;
      console.warn(`[worker] ${call.label} failed:`, message);
      return outcome(call, false, isTransientLlmError(message), false, undefined, []);
    }
  };
  const cli = input.calls.filter((call) => call.mode === 'agentic');
  const investigate = input.calls.filter((call) => call.mode === 'investigate');
  const api = input.calls.filter((call) => call.mode === 'api');
  const runCliLane = async () => {
    const outcomes: ReviewCallOutcome[] = [];
    for (const call of cli) outcomes.push(await runOne(call));
    return outcomes;
  };
  const runApiLanes = async () => {
    const lanes = groupApiCallsByProvider(api);
    const perProviderConcurrency = perReviewProviderParallelism(
      input.apiConcurrency,
      input.activeReviewCount,
    );
    console.log(
      `[worker] API provider scheduling: activeReviews=${Math.max(1, Math.floor(input.activeReviewCount))} ` +
        `perProviderPerReview=${perProviderConcurrency}`,
    );
    const laneOutcomes = await input.mapConcurrent(
      lanes,
      Math.min(input.apiConcurrency, lanes.length),
      async (lane) => {
        return input.mapConcurrent(interleaveProviderLane(lane), perProviderConcurrency, runOne);
      },
    );
    return laneOutcomes.flat();
  };
  const [cliOutcomes, investigateOutcomes, apiOutcomes] = await Promise.all([
    runCliLane(),
    input.mapConcurrent(investigate, 1, runOne),
    runApiLanes(),
  ]);
  return [...cliOutcomes, ...apiOutcomes, ...investigateOutcomes];
}

function outcome(
  call: ReviewCall,
  ok: boolean,
  transient: boolean,
  degraded: boolean,
  summary: string | undefined,
  findings: ReviewFinding[],
): ReviewCallOutcome {
  return {
    ok,
    transient,
    degraded,
    summary,
    findings,
    kind: call.kind,
    bestEffort: call.bestEffort ?? false,
    label: call.label,
    sample: call.sample,
    modelPassIndex: call.modelPassIndex,
    requiredCoverageKey: call.requiredCoverageKey,
  };
}
