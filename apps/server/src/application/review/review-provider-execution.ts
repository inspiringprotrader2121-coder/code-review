import {
  isTransientLlmError,
  llmFindingsToReviewFindings,
  REVIEW_INCOMPLETE_SUMMARY,
  runInvestigateReview,
  getProviderLoad,
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
  /** True when fleet/local admission refused the call (saturated / wait timed out). */
  admissionBlocked?: boolean;
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
  apiConcurrency: number;
}

export function groupApiCallsByProvider(calls: ReviewCall[]): ReviewCall[][] {
  // Calls retain their provider lane for capacity accounting. Individual lanes
  // may use more than one slot. Fleet capacity and cooldowns are enforced by
  // the provider admission coordinator at the actual paid-call boundary.
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
 * Bound one review's independent provider calls. Under fleet load, shrink
 * per-review fanout from getProviderLoad so each in-flight call finishes
 * under the LLM wall — same lenses/chunks, fewer simultaneous streams.
 * Do not divide blindly by active reviews when idle: that serializes large
 * PRs for no gain. Fleet admission still owns absolute capacity at the
 * paid-call boundary.
 */
export function reviewProviderParallelism(
  apiConcurrency: number,
  load?: { active: number; limit: number } | null,
): number {
  const configured = Math.max(1, Math.floor(apiConcurrency));
  if (!load || !Number.isFinite(load.limit) || load.limit <= 0) return configured;
  const active = Math.max(0, Math.floor(load.active));
  const limit = Math.max(1, Math.floor(load.limit));
  const free = Math.max(0, limit - active);
  const utilization = active / limit;
  // Idle / lightly loaded fleet: keep full per-review fanout.
  if (utilization < 0.5 && free >= configured) return configured;
  // Estimate how many reviews already share this provider, then fair-share
  // remaining slots without dropping any required coverage units.
  const estimatedPeers = Math.max(1, Math.ceil(active / configured) + 1);
  const fairShare = Math.max(1, Math.floor(Math.max(free, 1) / estimatedPeers));
  return Math.max(1, Math.min(configured, fairShare));
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
      const admissionBlocked =
        /concurrency saturated|admission timed out|provider lease|cooldown active/i.test(message) &&
        isTransientLlmError(message);
      return outcome(
        call,
        false,
        isTransientLlmError(message),
        false,
        undefined,
        [],
        admissionBlocked,
      );
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
    const laneOutcomes = await input.mapConcurrent(
      lanes,
      Math.min(input.apiConcurrency, lanes.length),
      async (lane) => {
        const provider = lane[0]?.target.admissionBucket ?? 'unknown';
        const load = await getProviderLoad(provider);
        const perProviderConcurrency = reviewProviderParallelism(input.apiConcurrency, load);
        console.log(
          `[worker] API provider scheduling: provider=${provider} ` +
            `perProviderPerReview=${perProviderConcurrency}` +
            (load ? ` load=${load.active}/${load.limit}` : '') +
            '; fleet admission enforces aggregate capacity',
        );
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
  admissionBlocked = false,
): ReviewCallOutcome {
  return {
    ok,
    transient,
    admissionBlocked,
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
