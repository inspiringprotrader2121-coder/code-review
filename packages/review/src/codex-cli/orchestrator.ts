import { randomUUID } from 'node:crypto';
import { currentEnvironment, loadReviewRuntimeConfig } from '@orvex-review/config';
import {
  commitProviderTpm,
  isOversizedModelRequest,
  isRetryableRateLimit,
  isTpmWindowError,
  parseRetryAfterMs,
  rateLimitRetryWaitMs,
  ReviewCancelledError,
  setProviderCooldown,
  waitToReserveProviderTpm,
  withProviderCallSlot,
  type LlmAttemptEvent,
} from '../llm-client.js';
import { estimateTokens } from '../llm/support.js';
import { interpretReviewContract } from '../llm.js';
import { recoverStructuredFinal, wrapStructuredFinalRepairUser } from '../llm/structured-final.js';
import { reviewResponseFingerprint } from '../llm/review-contract.js';
import type { ReviewableFile } from '../types.js';
import type { AttemptObserver, Clock } from '../providers/types.js';
import type { ProviderTpmPolicy } from '../llm/provider-admission.js';
import {
  benchCodexHome,
  codexHome,
  codexHomeCount,
  codexHomeLabel,
  decodeCodexThreadRef,
  encodeCodexThreadRef,
  pickCodexHome,
  withCodexResumeLock,
} from './admission.js';
import {
  DEFAULT_CODEX_CLI_MODEL,
  DEFAULT_CODEX_CLI_REASONING_EFFORT,
  CODEX_CLI_REPAIR_REASONING_EFFORT,
  type CodexCliReviewOptions,
  type CodexCliReviewResult,
} from './contracts.js';
import { executeCodex } from './execution.js';
import { buildCodexPrompt } from './prompt.js';
import { isStaleThreadError } from './protocol.js';
import {
  detectCodexAuthMode,
  isCodexAuthError,
  isCodexRepoAllowed,
  normalizeCodexAttemptError,
  resolveCodexRateLimitPolicy,
  systemClock,
  waitForCodexRetry,
} from './runtime.js';

function clockFor(options: CodexCliReviewOptions): Clock {
  return options.dependencies?.clock ?? systemClock;
}
function emitAttempt(options: CodexCliReviewOptions, event: LlmAttemptEvent): void {
  (options.dependencies?.attemptObserver as AttemptObserver | undefined)?.record(event);
  options.onAttempt?.(event);
}

type AttemptState = { lastAttemptId?: string; nextRetryIndex: number };
type WaitState = { sleptMs: number };

const LUNA_TPM_LANE = 'luna';

function lunaTpmPolicyForPrompt(
  prompt: string,
): Omit<ProviderTpmPolicy, 'reservationId'> | undefined {
  const runtime = loadReviewRuntimeConfig();
  if (!Number.isFinite(runtime.lunaTpmPerAccount) || runtime.lunaTpmPerAccount <= 0)
    return undefined;
  return {
    budget: runtime.lunaTpmPerAccount,
    reserveTokens: estimateTokens(prompt.length) + runtime.lunaTpmReserveOutput,
    windowMs: runtime.lunaTpmWindowMs,
    reserveTtlMs: Math.max(runtime.codexTimeoutMs, runtime.llmMaxTotalMs, 60_000),
  };
}

function resolveCodexTpmWaitBudget(options: CodexCliReviewOptions): {
  totalWaitBudgetMs: number;
  maxWaitMs: number;
} {
  const runtime = loadReviewRuntimeConfig();
  const injected = options.dependencies?.retryPolicy;
  return {
    totalWaitBudgetMs: Math.min(
      900_000,
      Math.max(
        1,
        Math.floor(injected?.totalWaitBudgetMs ?? Math.max(5_000, runtime.rateLimitTotalWaitMs)),
      ),
    ),
    maxWaitMs: Math.min(
      300_000,
      Math.max(
        2_000,
        Math.floor(injected?.maxWaitMs ?? Math.max(1_000, runtime.rateLimitMaxWaitMs)),
      ),
    ),
  };
}

function attemptHome(options: CodexCliReviewOptions, homeIndex: number): string | undefined {
  return options.codexHome ?? codexHome(homeIndex);
}

/**
 * Docker can reject a container before Codex starts when a burst exhausts a
 * short-lived host resource. These messages occur before a model response and
 * are safe to retry once with a fresh isolated container.
 */
export function isRecoverableSandboxLaunchFailure(message: string): boolean {
  return /(?:\btini\b[\s\S]*\bfork failed\b|\bfork failed:\s*resource temporarily unavailable\b|\bdocker\b[\s\S]*resource temporarily unavailable)/i.test(
    message,
  );
}
async function executeAttempt(
  prompt: string,
  options: CodexCliReviewOptions,
  state: AttemptState,
  homeIndex: number,
  threadId: string | undefined,
  waitState: WaitState,
  reasoningEffort = DEFAULT_CODEX_CLI_REASONING_EFFORT,
): Promise<{ text: string; threadId: string }> {
  const homePath = attemptHome(options, homeIndex);
  const authMode = detectCodexAuthMode(homePath);
  if (authMode !== 'apikey') {
    throw new Error(
      `codex-cli Luna requires API-key authentication; home ${homeIndex + 1} reports ${authMode}`,
    );
  }
  const clock = clockFor(options);
  const attemptId = randomUUID();
  const started = clock.now();
  const parentAttemptId = state.lastAttemptId;
  const retryIndex = state.nextRetryIndex++;
  state.lastAttemptId = attemptId;
  let startedEventEmitted = false;
  const emitStarted = () => {
    if (startedEventEmitted) return;
    startedEventEmitted = true;
    emitAttempt(options, {
      phase: 'started',
      attemptId,
      parentAttemptId,
      retryIndex,
      keyIndex: homeIndex,
      provider: 'codex-cli',
      model: DEFAULT_CODEX_CLI_MODEL,
      transport: 'codex-cli',
      startedAt: new Date(started).toISOString(),
    });
  };
  let dispatched = false;
  let succeeded = false;
  let billed = 0;
  const tpmPolicy = lunaTpmPolicyForPrompt(prompt);
  const tpmWait = resolveCodexTpmWaitBudget(options);
  let reservationId: string | undefined;
  if (tpmPolicy) {
    const reserved = await waitToReserveProviderTpm({
      providerLabel: 'Luna',
      lane: LUNA_TPM_LANE,
      policy: tpmPolicy,
      totalWaitBudgetMs: tpmWait.totalWaitBudgetMs,
      sleptMs: waitState.sleptMs,
      signal: options.signal,
      coordinator: options.dependencies?.admission,
      sleep: (ms, signal) => waitForCodexRetry(ms, signal, clock),
      logPrefix: '[codex-cli]',
    });
    waitState.sleptMs = reserved.sleptMs;
    reservationId = reserved.reservationId;
  }
  try {
    const result = await withCodexResumeLock(
      homeIndex,
      threadId,
      DEFAULT_CODEX_CLI_MODEL,
      () =>
        withProviderCallSlot(
          'luna',
          () => {
            dispatched = true;
            emitStarted();
            return executeCodex(prompt, {
              model: DEFAULT_CODEX_CLI_MODEL,
              reasoningEffort,
              threadId,
              cwd: options.cwd,
              home: homePath,
              homeIdx: homeIndex,
              signal: options.signal,
              clock: options.dependencies?.clock,
              spawn: options.dependencies?.spawn,
              container: options.dependencies?.codexContainer,
              onUsage: (usage) => {
                if (usage.tokenSource !== 'estimate') {
                  billed += Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
                }
                options.onUsage?.({ ...usage, attemptId });
              },
            });
          },
          options.signal,
          options.dependencies?.admission,
        ),
      options.signal,
    );
    succeeded = true;
    emitAttempt(options, {
      phase: 'finished',
      attemptId,
      outcome: 'succeeded',
      dispatched,
      durationMs: clock.now() - started,
      completedAt: new Date(clock.now()).toISOString(),
    });
    return result;
  } catch (error) {
    // Admission/lock failures still get a complete durable lifecycle, but are
    // explicitly non-dispatched and therefore cannot imply unknown provider spend.
    emitStarted();
    const normalized = normalizeCodexAttemptError(error, options.signal);
    const message = normalized.message;
    const outcome =
      normalized instanceof ReviewCancelledError
        ? 'cancelled'
        : /wall-clock cap|timed?\s*out|produced no output/i.test(message)
          ? 'timed_out'
          : isRetryableRateLimit(message)
            ? 'rate_limited'
            : 'failed';
    emitAttempt(options, {
      phase: 'finished',
      attemptId,
      outcome,
      dispatched,
      durationMs: clock.now() - started,
      completedAt: new Date(clock.now()).toISOString(),
      error: message.slice(0, 2_000),
    });
    throw normalized;
  } finally {
    if (reservationId && tpmPolicy) {
      const actual = billed > 0 ? billed : succeeded ? tpmPolicy.reserveTokens : 0;
      await commitProviderTpm(
        {
          lane: LUNA_TPM_LANE,
          reservationId,
          actualTokens: Math.max(0, Math.floor(actual)),
          windowMs: tpmPolicy.windowMs,
        },
        options.dependencies?.admission,
      );
    }
  }
}

async function executeWithStaleThreadRecovery(
  prompt: string,
  options: CodexCliReviewOptions,
  state: AttemptState,
  homeIndex: number,
  threadId: string | undefined,
  waitState: WaitState,
  reasoningEffort = DEFAULT_CODEX_CLI_REASONING_EFFORT,
): Promise<{ text: string; threadId: string }> {
  try {
    return await executeAttempt(
      prompt,
      options,
      state,
      homeIndex,
      threadId,
      waitState,
      reasoningEffort,
    );
  } catch (error) {
    if (threadId && isStaleThreadError((error as Error).message)) {
      return executeAttempt(
        prompt,
        options,
        state,
        homeIndex,
        undefined,
        waitState,
        reasoningEffort,
      );
    }
    throw error;
  }
}

function lunaTpmAdmissionError(cause: Error): Error {
  const retryAfterSec = Math.max(
    1,
    Math.ceil((parseRetryAfterMs(cause.message) ?? 60_000) / 1_000),
  );
  return new Error(
    `429 rate-limited on every luna key (1); retry-after: ${retryAfterSec}; ${cause.message.slice(0, 160)}`,
  );
}

async function executeWithRateLimitRecovery(
  prompt: string,
  options: CodexCliReviewOptions,
  state: AttemptState,
  homeIndex: number,
  threadId: string | undefined,
  waitState: WaitState,
  reasoningEffort = DEFAULT_CODEX_CLI_REASONING_EFFORT,
): Promise<{ text: string; threadId: string }> {
  const policy = resolveCodexRateLimitPolicy(
    currentEnvironment(),
    options.dependencies?.retryPolicy,
  );
  const tpmWait = resolveCodexTpmWaitBudget(options);
  for (let retry = 0; ; retry++) {
    if (options.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
    try {
      return await executeWithStaleThreadRecovery(
        prompt,
        options,
        state,
        homeIndex,
        threadId,
        waitState,
        reasoningEffort,
      );
    } catch (error) {
      const message = (error as Error).message;
      const tpmWindow = isTpmWindowError(message);
      if (isOversizedModelRequest(message) || !isRetryableRateLimit(message)) throw error;
      if (!tpmWindow && retry >= policy.maxAttempts - 1) throw error;
      const announced = parseRetryAfterMs(message);
      if (!tpmWindow && announced !== undefined && announced > policy.maxWaitMs) throw error;
      const wait = tpmWindow
        ? rateLimitRetryWaitMs(message, 2_000, tpmWait.maxWaitMs)
        : Math.min(
            (announced ?? Math.min(15_000 * 2 ** retry, policy.maxWaitMs)) +
              Math.floor(Math.random() * 2_000),
            policy.maxWaitMs,
          );
      const budget = tpmWindow ? tpmWait.totalWaitBudgetMs : policy.totalWaitBudgetMs;
      if (waitState.sleptMs + wait > budget) {
        throw tpmWindow ? lunaTpmAdmissionError(error as Error) : error;
      }
      waitState.sleptMs += wait;
      console.warn(
        tpmWindow
          ? `[codex-cli] Luna TPM window — holding ${Math.round(wait / 1000)}s then retrying when free: ${message.slice(0, 140)}`
          : `[codex-cli] rate-limited — holding ${Math.round(wait / 1000)}s then retrying (${retry + 1}/${policy.maxAttempts - 1})`,
      );
      await setProviderCooldown(LUNA_TPM_LANE, wait, options.dependencies?.admission);
      await waitForCodexRetry(wait, options.signal, clockFor(options));
    }
  }
}

async function executeWithSandboxLaunchRecovery(
  prompt: string,
  options: CodexCliReviewOptions,
  state: AttemptState,
  homeIndex: number,
  threadId: string | undefined,
  waitState: WaitState,
  reasoningEffort = DEFAULT_CODEX_CLI_REASONING_EFFORT,
): Promise<{ text: string; threadId: string }> {
  let retryThreadId = threadId;
  for (let launchAttempt = 0; launchAttempt < 2; launchAttempt++) {
    try {
      return await executeWithRateLimitRecovery(
        prompt,
        options,
        state,
        homeIndex,
        retryThreadId,
        waitState,
        reasoningEffort,
      );
    } catch (error) {
      const message = (error as Error).message;
      if (
        launchAttempt > 0 ||
        options.signal?.aborted ||
        !isRecoverableSandboxLaunchFailure(message)
      ) {
        throw error;
      }
      // The failed container never produced a model response. Retry only once,
      // on a clean thread, so a capacity blip cannot erase the other completed
      // review lenses or trigger an unbounded paid retry loop.
      console.warn('[codex-cli] sandbox launch failed before model execution; retrying once');
      retryThreadId = undefined;
      await waitForCodexRetry(1_000, options.signal, clockFor(options));
    }
  }
  throw new Error('codex-cli sandbox launch recovery exhausted');
}

/** Run the pinned Luna agent via the internal credential-isolating container only. */
export async function runCodexCliReview(
  files: ReviewableFile[],
  options: CodexCliReviewOptions = {},
): Promise<CodexCliReviewResult> {
  if (options.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
  if (!isCodexRepoAllowed(options.repoId))
    throw new Error(
      `Codex CLI review refused without a repository identity ${options.repoId ?? '(unknown repo)'}`,
    );
  const container = options.dependencies?.codexContainer;
  if (!container)
    throw new Error('codex-cli requires the internal credential-isolating container runtime');
  await container.assertReady(options.signal);
  let promptMode = options.promptMode ?? (options.cwd ? 'lean' : 'full');
  let prompt = buildCodexPrompt(files, options.context, {
    hasRepoCheckout: Boolean(options.cwd),
    mode: promptMode,
  });
  const state: AttemptState = { nextRetryIndex: 0 };
  const waitState: WaitState = { sleptMs: 0 };
  const stored = decodeCodexThreadRef(options.threadId);
  let homeIndex = pickCodexHome(stored.homeIdx);
  let threadId = stored.homeIdx === homeIndex ? stored.threadId : undefined;
  let usedSlimRetry = promptMode === 'slim';
  let result: { text: string; threadId: string } | undefined;
  let parsed: NonNullable<ReturnType<typeof interpretReviewContract>['response']> | undefined;
  for (let homeAttempts = 0; ; homeAttempts++) {
    try {
      let lastRaw = '';
      let lastInterpretation: ReturnType<typeof interpretReviewContract> | undefined;
      parsed = await recoverStructuredFinal({
        stage: 'luna',
        model: DEFAULT_CODEX_CLI_MODEL,
        provider: 'codex-cli',
        api: 'codex-cli',
        generate: async ({ source, previousText }) => {
          const userPrompt =
            source === 'recovery' ? wrapStructuredFinalRepairUser(prompt, previousText) : prompt;
          const exec = await executeWithSandboxLaunchRecovery(
            userPrompt,
            options,
            state,
            homeIndex,
            source === 'recovery' ? undefined : threadId,
            waitState,
            source === 'recovery'
              ? CODEX_CLI_REPAIR_REASONING_EFFORT
              : DEFAULT_CODEX_CLI_REASONING_EFFORT,
          );
          result = exec;
          lastRaw = exec.text;
          lastInterpretation = undefined;
          console.log(
            `[luna] ${JSON.stringify({
              event: 'codex_process_success',
              stage: 'luna',
              model: 'luna',
              apiCall: 'success',
              codexProcess: 'success',
              processExitStatus: 0,
              rawResponseReceived: Boolean(exec.text),
              ...reviewResponseFingerprint(exec.text),
              source,
            })}`,
          );
          return exec.text;
        },
        parse: (text) => {
          lastInterpretation = interpretReviewContract(text);
          if (!lastInterpretation.ok || !lastInterpretation.response) {
            throw (
              lastInterpretation.error ?? new Error('LLM review JSON was missing findings/issues')
            );
          }
          if (lastInterpretation.rejectedFindingCount > 0) {
            console.warn(
              `[luna] dropped ${lastInterpretation.rejectedFindingCount} malformed finding(s); kept ${lastInterpretation.usableFindingCount}`,
            );
          }
          return lastInterpretation.response;
        },
        log: (entry) => {
          const repair = Number(entry.semanticRepairAttempt ?? 0);
          const accepted = Boolean(entry.accepted);
          const reason =
            typeof entry.coverageFailure === 'string'
              ? entry.coverageFailure
              : lastInterpretation?.coverageFailure;
          const parseEvent = accepted
            ? 'review_parse_success'
            : reason === 'all_findings_unusable'
              ? 'review_no_usable_findings'
              : reason === 'no_parseable_review_json'
                ? 'review_parse_failure'
                : 'review_schema_failure';
          const repairEvent = repair > 0 ? `semantic_repair_${repair}` : undefined;
          const coverageEvent = accepted ? 'coverage_complete' : 'coverage_failed';
          const events = [
            'codex_process_success',
            parseEvent,
            ...(repairEvent ? [repairEvent] : []),
            ...(accepted || repair >= 2 ? [coverageEvent] : []),
          ];
          console.log(
            `[luna] ${JSON.stringify({
              event: accepted ? coverageEvent : parseEvent,
              events,
              stage: 'luna',
              model: 'luna',
              ...reviewResponseFingerprint(lastRaw),
              ...entry,
              apiCall: 'success',
              codexProcess: 'success',
              processExitStatus: 0,
              rawResponseReceived: lastRaw.length > 0,
              contractParse: accepted ? 'ok' : 'failed',
              usableFindingCount: lastInterpretation?.usableFindingCount ?? 0,
              rejectedFindingCount: lastInterpretation?.rejectedFindingCount ?? 0,
              coverageStatus: accepted ? 'complete' : 'failed',
              coverageFailureReason: accepted ? undefined : reason,
              repairExhausted: !accepted && repair >= 2,
              recoveryMode: entry.recoveryMode,
              semanticRepairAttempt: repair,
            })}`,
          );
          if (repair > 0) {
            console.log(`[luna] Semantic repair #${repair}: ${accepted ? 'ok' : 'failed'}`);
          } else {
            console.log(`[luna] Contract parse: ${accepted ? 'ok' : 'failed'}`);
          }
          if (!accepted && repair >= 2) {
            console.log(
              `[luna] Coverage unit: failed | Reason: ${reason ?? 'invalid_review_contract'}`,
            );
          } else if (accepted) {
            console.log('[luna] Coverage unit: succeeded');
          }
          const attemptId = state.lastAttemptId;
          if (!attemptId) return;
          emitAttempt(options, {
            phase: 'coverage',
            attemptId,
            coverageStatus: accepted ? 'succeeded' : 'failed',
            coverageFailure: accepted ? undefined : reason,
            parseResult: typeof entry.parseResult === 'string' ? entry.parseResult : undefined,
            keptFindings: lastInterpretation?.usableFindingCount,
            droppedFindings: lastInterpretation?.rejectedFindingCount,
          });
        },
      });
      break;
    } catch (error) {
      const message = (error as Error).message;
      if (isOversizedModelRequest(message) && !usedSlimRetry && options.cwd) {
        usedSlimRetry = true;
        promptMode = 'slim';
        threadId = undefined;
        prompt = buildCodexPrompt(files, options.context, {
          hasRepoCheckout: true,
          mode: promptMode,
        });
        continue;
      }
      if (!isCodexAuthError(message)) throw error;
      benchCodexHome(homeIndex);
      const next = pickCodexHome();
      if (next === homeIndex || homeAttempts + 1 >= codexHomeCount()) throw error;
      homeIndex = next;
      threadId = undefined;
    }
  }
  if (!result?.threadId && !threadId) throw new Error('codex-cli did not return a session id');
  if (!parsed) throw new Error('codex-cli did not return a parseable review');
  const maxFindings = loadReviewRuntimeConfig().maxFindings;
  return {
    response: {
      ...parsed,
      findings: parsed.findings
        .slice(0, maxFindings)
        .map((finding) => ({ ...finding, ruleId: finding.ruleId ?? `llm.${finding.category}` })),
    },
    threadId: encodeCodexThreadRef(homeIndex, result!.threadId || threadId!),
  };
}

/** Sessions exist only inside disposable private checkouts; kept for compatibility. */
export async function closeCodexSession(threadRef: string): Promise<void> {
  void threadRef;
}

export { codexHomeLabel };
