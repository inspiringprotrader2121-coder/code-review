import { randomUUID } from 'node:crypto';
import { currentEnvironment, loadReviewRuntimeConfig } from '@orvex-review/config';
import {
  extractJsonLoose,
  isOversizedModelRequest,
  isRetryableRateLimit,
  parseRetryAfterMs,
  ReviewCancelledError,
  setProviderCooldown,
  withProviderCallSlot,
  type LlmAttemptEvent,
} from '../llm-client.js';
import { normalizeLlmResponse } from '../llm.js';
import { LlmReviewResponseSchema, type ReviewableFile } from '../types.js';
import type { AttemptObserver, Clock } from '../providers/types.js';
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
): Promise<{ text: string; threadId: string }> {
  const authMode = detectCodexAuthMode(codexHome(homeIndex));
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
              reasoningEffort: DEFAULT_CODEX_CLI_REASONING_EFFORT,
              threadId,
              cwd: options.cwd,
              home: codexHome(homeIndex),
              homeIdx: homeIndex,
              signal: options.signal,
              clock: options.dependencies?.clock,
              spawn: options.dependencies?.spawn,
              container: options.dependencies?.codexContainer,
              onUsage: options.onUsage
                ? (usage) => options.onUsage?.({ ...usage, attemptId })
                : undefined,
            });
          },
          options.signal,
          options.dependencies?.admission,
        ),
      options.signal,
    );
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
  }
}

async function executeWithStaleThreadRecovery(
  prompt: string,
  options: CodexCliReviewOptions,
  state: AttemptState,
  homeIndex: number,
  threadId: string | undefined,
): Promise<{ text: string; threadId: string }> {
  try {
    return await executeAttempt(prompt, options, state, homeIndex, threadId);
  } catch (error) {
    if (threadId && isStaleThreadError((error as Error).message)) {
      return executeAttempt(prompt, options, state, homeIndex, undefined);
    }
    throw error;
  }
}

async function executeWithRateLimitRecovery(
  prompt: string,
  options: CodexCliReviewOptions,
  state: AttemptState,
  homeIndex: number,
  threadId: string | undefined,
): Promise<{ text: string; threadId: string }> {
  const policy = resolveCodexRateLimitPolicy(
    currentEnvironment(),
    options.dependencies?.retryPolicy,
  );
  let slept = 0;
  for (let retry = 0; ; retry++) {
    if (options.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
    try {
      return await executeWithStaleThreadRecovery(prompt, options, state, homeIndex, threadId);
    } catch (error) {
      const message = (error as Error).message;
      if (
        isOversizedModelRequest(message) ||
        retry >= policy.maxAttempts - 1 ||
        !isRetryableRateLimit(message)
      )
        throw error;
      const announced = parseRetryAfterMs(message);
      if (announced !== undefined && announced > policy.maxWaitMs) throw error;
      const wait = Math.min(
        (announced ?? Math.min(15_000 * 2 ** retry, policy.maxWaitMs)) +
          Math.floor(Math.random() * 2_000),
        policy.maxWaitMs,
      );
      if (slept + wait > policy.totalWaitBudgetMs) throw error;
      slept += wait;
      await setProviderCooldown('luna', wait, options.dependencies?.admission);
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
): Promise<{ text: string; threadId: string }> {
  let retryThreadId = threadId;
  for (let launchAttempt = 0; launchAttempt < 2; launchAttempt++) {
    try {
      return await executeWithRateLimitRecovery(prompt, options, state, homeIndex, retryThreadId);
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
  const stored = decodeCodexThreadRef(options.threadId);
  let homeIndex = pickCodexHome(stored.homeIdx);
  let threadId = stored.homeIdx === homeIndex ? stored.threadId : undefined;
  let usedSlimRetry = promptMode === 'slim';
  let result: { text: string; threadId: string } | undefined;
  for (let homeAttempts = 0; ; homeAttempts++) {
    try {
      result = await executeWithSandboxLaunchRecovery(prompt, options, state, homeIndex, threadId);
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
  const parsed = LlmReviewResponseSchema.parse(
    normalizeLlmResponse(extractJsonLoose(result!.text)),
  );
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
