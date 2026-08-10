import {
  isOversizedModelRequest,
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
  getCodexThreadId: () => string | undefined;
  setCodexThreadId: (threadId: string | undefined) => void;
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
  const lanes = new Map<string, ReviewCall[]>();
  for (const call of calls) {
    const bucket = call.target.admissionBucket ?? call.target.baseUrl ?? call.target.model;
    const lane = lanes.get(bucket) ?? [];
    lane.push(call);
    lanes.set(bucket, lane);
  }
  return [...lanes.values()];
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
          const { response, threadId } = await input.providers.runCodexReview(
            input.filesForLlm,
            call.target,
            {
              threadId: call.freshAgenticSession ? undefined : input.getCodexThreadId(),
              context: call.ctx,
              cwd: input.repoDirectory ?? undefined,
              repoId: input.repoId,
              signal: input.signal,
              onUsage: input.onUsageFor(call.tier, call.target, call.label),
              onAttempt: input.onAttemptFor(call.tier, call.label),
            },
          );
          if (!call.freshAgenticSession) input.setCodexThreadId(threadId);
          const findings = llmFindingsToReviewFindings(response.findings);
          input.tagFindings(findings, call.tier, call.passTag);
          const degraded = findings.length === 0 && response.summary === REVIEW_INCOMPLETE_SUMMARY;
          console.log(
            `[worker] ${call.label}: +${findings.length} findings${degraded ? ' (degraded/unparseable)' : ''}`,
          );
          return outcome(call, !degraded, false, degraded, response.summary, findings);
        } catch (error) {
          const message = (error as Error).message;
          if (isOversizedModelRequest(message)) input.setCodexThreadId(undefined);
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
    const laneOutcomes = await input.mapConcurrent(
      lanes,
      Math.min(input.apiConcurrency, lanes.length),
      async (lane) => {
        const outcomes: ReviewCallOutcome[] = [];
        for (const call of lane) outcomes.push(await runOne(call));
        return outcomes;
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
  };
}
