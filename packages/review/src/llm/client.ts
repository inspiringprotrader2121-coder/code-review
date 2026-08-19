import { createHash, randomUUID } from 'node:crypto';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import type { RetryPolicy } from '../providers/types.js';
import type { LlmClientOptions, LlmProviderCoordinator } from './contracts.js';
import { ReviewCancelledError, isReviewCancelledError, throwIfCancelled } from './cancellation.js';
import {
  commitProviderTpm,
  currentProviderCoordinator,
  getProviderCooldownMs,
  isProviderAdmissionError,
  providerBucketForTarget,
  providerKeyLane,
  selectProviderKey,
  setProviderCooldown,
  splitApiKeys,
  tryReserveProviderTpm,
  waitForProviderAvailability,
  withProviderCallSlot,
  type ProviderTpmPolicy,
} from './provider-admission.js';
import {
  allocateAttemptIndex,
  recordProviderAdmissionFailure,
  trackedLlmAttempt,
  type AttemptLineage,
} from './lifecycle.js';
import {
  isRetryableEmptyProviderResponse,
  isRetryableRateLimit,
  isTpmWindowError,
  parseRetryAfterMs,
  rateLimitRetryWaitMs,
  sleep,
} from './retry-policy.js';
import { clockFor, estimateTokens, maxTotalMs } from './support.js';
import {
  classifyStructuredOutput,
  extractJsonLoose,
  jsonContractMissing,
  jsonFinishPrefix,
  JsonContractMismatchError,
  stripThinking,
} from './parsing.js';
import { DeepSeekContinuationRequiredError } from './transports.js';

function workerKeyCursorSeed(id = loadReviewRuntimeConfig().workerId ?? ''): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = (hash * 33 + id.charCodeAt(index)) >>> 0;
  }
  return hash;
}

let keyCursor = workerKeyCursorSeed();
// Primary max-reasoning can exhaust the shared completion budget with zero JSON.
// Continuations must finish the answer under load; keep them answer-only (thinking
// off) with enough wall/token headroom that a queued multi-tenant burst still
// completes in minutes instead of marking required lenses incomplete.
const MAX_PREFIX_CONTINUATIONS = 2;
const PREFIX_CONTINUATION_MAX_MS = 180_000;
const PREFIX_CONTINUATION_MAX_TOKENS = 24_000;
const MAX_CONTINUATION_RATE_LIMIT_RETRIES = 2;

function jsonContractDiagnostic(text: string): string {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  const stripped = stripThinking(text);
  const fence = /```/.test(stripped);
  const objectStart = stripped.indexOf('{');
  const prosePrefix = objectStart > 0 && stripped.slice(0, objectStart).trim().length > 0;
  let parsed: unknown;
  try {
    parsed = extractJsonLoose(text);
  } catch {
    parsed = undefined;
  }
  let shape = 'unparseable';
  if (Array.isArray(parsed)) shape = 'array';
  else if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed)
      .slice(0, 12)
      .map((key) => key.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40));
    shape = `object keys=${keys.join(',') || '(none)'}`;
  } else if (parsed !== undefined) shape = typeof parsed;
  else if (!stripped) shape = 'empty';
  else if (fence) shape = 'markdown_fence';
  else if (prosePrefix) shape = 'prose_prefix';
  return `chars=${text.length} sha256=${digest} shape=${shape} fence=${fence} prosePrefix=${prosePrefix}`;
}

function structuredOutputLogFields(opts: LlmClientOptions, continuationCount: number) {
  return {
    schemaEnforced: Boolean(opts.jsonSchema),
    schemaName: opts.jsonSchema?.name ?? null,
    semanticRepairAttempt: opts.semanticRepairAttempt ?? 0,
    continuationAttempt: continuationCount,
  };
}

function rateLimitAdmissionError(provider: string, keyCount: number, cause: Error): Error {
  const retryAfterSec = Math.max(
    1,
    Math.ceil((parseRetryAfterMs(cause.message) ?? 60_000) / 1_000),
  );
  return new Error(
    `429 rate-limited on every ${provider} key (${keyCount}); retry-after: ${retryAfterSec}; ${cause.message.slice(0, 160)}`,
  );
}

function providerDisplayName(provider: string): string {
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'luna') return 'Luna';
  if (provider === 'minimax') return 'MiniMax';
  return provider;
}

function tpmPolicyForCall(
  provider: string,
  runtime: ReturnType<typeof loadReviewRuntimeConfig>,
  system: string,
  user: string,
  maxTokens: number | undefined,
): Omit<ProviderTpmPolicy, 'reservationId'> | undefined {
  const spec =
    provider === 'luna'
      ? {
          budget: runtime.lunaTpmPerAccount,
          windowMs: runtime.lunaTpmWindowMs,
          reserveOutput: runtime.lunaTpmReserveOutput,
        }
      : provider === 'deepseek'
        ? {
            budget: runtime.deepseekTpmPerAccount,
            windowMs: runtime.deepseekTpmWindowMs,
            reserveOutput: runtime.deepseekTpmReserveOutput,
          }
        : provider === 'minimax'
          ? {
              budget: runtime.minimaxTpmPerAccount,
              windowMs: runtime.minimaxTpmWindowMs,
              reserveOutput: runtime.minimaxTpmReserveOutput,
            }
          : undefined;
  if (!spec || !Number.isFinite(spec.budget) || spec.budget <= 0) return undefined;
  return {
    budget: spec.budget,
    reserveTokens:
      estimateTokens(system.length + user.length) +
      Math.min(maxTokens ?? runtime.maxOutputTokens, spec.reserveOutput),
    windowMs: spec.windowMs,
    reserveTtlMs: Math.max(runtime.llmMaxTotalMs, 60_000),
  };
}

interface ActiveProviderKey {
  apiKey: string;
  keyIndex: number;
  lane: string;
}

interface TpmSession {
  lease: { lane: string; reservationId: string } | null;
  billed: number;
  flush: (actualTokens: number) => Promise<void>;
  attach: (lease: { lane: string; reservationId: string }) => void;
}

/**
 * One paid-call slot covers the primary attempt plus bounded answer-only
 * continuations so continuations never rejoin the back of a multi-minute fleet
 * wait queue after Luna already succeeded.
 * A continuation 429 rotates to a cool sibling key without replaying the primary.
 */
async function llmChatHoldingProviderSlot(
  system: string,
  user: string,
  opts: LlmClientOptions,
  lineage: AttemptLineage,
  start: ActiveProviderKey,
  pool: {
    provider: string;
    keys: readonly string[];
    coordinator: LlmProviderCoordinator | undefined;
    tpm?: Omit<ProviderTpmPolicy, 'reservationId'>;
    tpmSession: TpmSession;
  },
): Promise<string> {
  const runtime = loadReviewRuntimeConfig();
  const baseMs = Math.min(60_000, Math.max(250, runtime.rateLimitBaseMs));
  const maxWaitMs = Math.min(300_000, Math.max(1_000, runtime.rateLimitMaxWaitMs));
  let current = start;
  const triedContinuationLanes = new Set<string>([start.lane]);
  let continuationCount = 0;
  let continuation: LlmClientOptions['compatibleContinuation'];
  let continuationRateLimitAttempt = 0;
  let lastContractMissText: string | undefined;

  const rotateContinuationKey = async (): Promise<boolean> => {
    if (pool.keys.length <= 1) return false;
    for (let offset = 1; offset < pool.keys.length; offset++) {
      const keyIndex = (current.keyIndex + offset) % pool.keys.length;
      const lane = providerKeyLane(pool.provider, keyIndex, pool.keys.length);
      if (triedContinuationLanes.has(lane)) continue;
      if ((await getProviderCooldownMs(lane, pool.coordinator)) > 0) continue;
      let nextLease: { lane: string; reservationId: string } | undefined;
      if (pool.tpm) {
        const reservationId = randomUUID();
        const reserved = await tryReserveProviderTpm(
          {
            lane,
            tokens: Math.min(PREFIX_CONTINUATION_MAX_TOKENS, pool.tpm.reserveTokens),
            budget: pool.tpm.budget,
            windowMs: pool.tpm.windowMs,
            reservationId,
            reserveTtlMs: pool.tpm.reserveTtlMs,
          },
          pool.coordinator,
        );
        if (!reserved.ok) continue;
        nextLease = { lane, reservationId };
      }
      await setProviderCooldown(current.lane, Math.max(2_000, baseMs), pool.coordinator);
      await pool.tpmSession.flush(pool.tpmSession.billed);
      if (nextLease) pool.tpmSession.attach(nextLease);
      current = { apiKey: pool.keys[keyIndex]!, keyIndex, lane };
      triedContinuationLanes.add(lane);
      continuationRateLimitAttempt = 0;
      console.warn(
        `[llm] DeepSeek continuation rate-limited on prior key — rotating to cool key ${lane} (${triedContinuationLanes.size}/${pool.keys.length} keys tried)`,
      );
      return true;
    }
    return false;
  };

  for (;;) {
    throwIfCancelled(opts.signal);
    const attemptOpts: LlmClientOptions = {
      ...opts,
      apiKey: current.apiKey,
      compatibleContinuation: continuation,
      ...(continuation ? { thinking: false } : {}),
      hardLimitMs: continuation
        ? Math.min(opts.hardLimitMs ?? maxTotalMs(), PREFIX_CONTINUATION_MAX_MS)
        : opts.hardLimitMs,
      maxTokens: continuation
        ? Math.min(opts.maxTokens ?? PREFIX_CONTINUATION_MAX_TOKENS, PREFIX_CONTINUATION_MAX_TOKENS)
        : opts.maxTokens,
    };
    try {
      const text = await trackedLlmAttempt(
        system,
        user,
        attemptOpts,
        allocateAttemptIndex(lineage),
        current.keyIndex,
        lineage,
      );
      if (opts.json && jsonContractMissing(text, opts.jsonContractKeys)) {
        const stopReason = attemptOpts.generationStopReason;
        const classified = classifyStructuredOutput(text, opts.jsonContractKeys, stopReason);
        if (classified.recoveryMode !== 'continuation') {
          console.warn(
            `[llm] ${JSON.stringify({
              stage: 'structured_output',
              model: opts.model,
              provider: pool.provider,
              api: opts.api,
              stopReason: stopReason ?? 'completed',
              responseShape: classified.failureClass,
              parseResult: classified.parseResult,
              failureClass: classified.failureClass,
              recoveryMode: classified.recoveryMode,
              ...structuredOutputLogFields(opts, continuationCount),
              diagnostic: jsonContractDiagnostic(text),
            })}`,
          );
          console.warn(
            `[llm] JSON contract missing; ${jsonContractDiagnostic(text)} stop=${stopReason ?? 'completed'} failureClass=${classified.failureClass} recovery=${classified.recoveryMode}`,
          );
          throw new JsonContractMismatchError(text, { ...classified, stopReason });
        }
        const contentPrefix = jsonFinishPrefix(text, opts.jsonContractPrefix);
        if (contentPrefix === null) {
          console.warn(`[llm] JSON contract mismatch; ${jsonContractDiagnostic(text)}`);
          throw new JsonContractMismatchError(text, { ...classified, stopReason });
        }
        // Some compatible providers ignore the assistant prefix and return the
        // same schema-wrong object verbatim. A second identical continuation
        // cannot make progress; stop paying for copies so the stage-specific
        // caller can make its one cheap semantic-format repair instead.
        if (continuation && text.trim() === lastContractMissText?.trim()) {
          console.warn(`[llm] repeated JSON contract miss; ${jsonContractDiagnostic(text)}`);
          throw new Error(
            'LLM response contained no parseable JSON; answer-only continuation made no progress',
          );
        }
        if (continuationCount >= MAX_PREFIX_CONTINUATIONS) {
          throw new Error('LLM response contained no parseable JSON');
        }
        lastContractMissText = text;
        continuation = {
          reasoningContent: continuation?.reasoningContent ?? '',
          contentPrefix,
        };
        continuationCount++;
        continuationRateLimitAttempt = 0;
        console.warn(
          `[llm] ${JSON.stringify({
            stage: 'structured_output',
            model: opts.model,
            provider: pool.provider,
            api: opts.api,
            stopReason: stopReason ?? 'truncated',
            parseResult: classified.parseResult,
            failureClass: classified.failureClass,
            recoveryMode: 'continuation',
            ...structuredOutputLogFields(opts, continuationCount),
            diagnostic: jsonContractDiagnostic(text),
          })}`,
        );
        console.warn(
          `[llm] JSON contract missing; ${jsonContractDiagnostic(text)}; truncated stop=${stopReason ?? 'unknown'}; continuing the same response (${continuationCount}/${MAX_PREFIX_CONTINUATIONS})`,
        );
        continue;
      }
      return text;
    } catch (error) {
      const lastError =
        opts.signal?.aborted && !isReviewCancelledError(error)
          ? new ReviewCancelledError()
          : (error as Error);
      if (isReviewCancelledError(lastError) || opts.signal?.aborted)
        throw new ReviewCancelledError();
      if (lastError instanceof DeepSeekContinuationRequiredError) {
        if (continuationCount >= MAX_PREFIX_CONTINUATIONS) {
          throw new Error(
            `LLM response remained truncated after ${MAX_PREFIX_CONTINUATIONS} bounded prefix continuation`,
          );
        }
        continuation = lastError.continuation;
        continuationCount++;
        continuationRateLimitAttempt = 0;
        console.warn(
          `[llm] ${JSON.stringify({
            stage: 'structured_output',
            model: opts.model,
            provider: pool.provider,
            api: opts.api,
            stopReason: attemptOpts.generationStopReason ?? 'truncated',
            parseResult: 'invalid',
            failureClass: 'truncated_json',
            recoveryMode: 'continuation',
            ...structuredOutputLogFields(opts, continuationCount),
          })}`,
        );
        console.warn(
          `[llm] max-reasoning output exhausted; continuing the same response (${continuationCount}/${MAX_PREFIX_CONTINUATIONS})`,
        );
        continue;
      }
      if (continuation && isRetryableRateLimit(lastError.message)) {
        if (await rotateContinuationKey()) continue;
        continuationRateLimitAttempt++;
        if (continuationRateLimitAttempt > MAX_CONTINUATION_RATE_LIMIT_RETRIES) {
          throw new Error(
            `429 DeepSeek continuation rate-limited after ${MAX_CONTINUATION_RATE_LIMIT_RETRIES} retries; ${lastError.message.slice(0, 160)}`,
          );
        }
        const advertised = parseRetryAfterMs(lastError.message);
        const waitMs = Math.min(
          (advertised ?? baseMs) + Math.floor(Math.random() * 1_000),
          maxWaitMs,
        );
        console.warn(
          `[llm] DeepSeek continuation rate-limited — holding provider slot ${Math.round(waitMs / 1000)}s then retrying (${continuationRateLimitAttempt}/${MAX_CONTINUATION_RATE_LIMIT_RETRIES})`,
        );
        await sleep(waitMs, opts.signal, clockFor(opts));
        continue;
      }
      throw lastError;
    }
  }
}

export async function llmChat(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  const injectedPolicy: RetryPolicy | undefined = opts.dependencies?.retryPolicy;
  const runtime = loadReviewRuntimeConfig();
  const waitRetryCeiling = Math.min(
    2,
    Math.max(1, Math.floor(injectedPolicy?.maxAttempts ?? runtime.rateLimitMaxRetries)),
  );
  const maxWaitMs = Math.min(
    300_000,
    Math.max(
      1,
      Math.floor(injectedPolicy?.maxWaitMs ?? Math.max(1_000, runtime.rateLimitMaxWaitMs)),
    ),
  );
  const baseMs = Math.min(
    60_000,
    Math.max(1, Math.floor(injectedPolicy?.baseMs ?? Math.max(250, runtime.rateLimitBaseMs))),
  );
  // Long TPM windows (30–120s) must be waitable via config; do not silently clamp to 60s.
  // Injected test budgets may be smaller than the 5s production floor.
  const totalWaitBudgetMs = Math.min(
    900_000,
    Math.max(
      1,
      Math.floor(
        injectedPolicy?.totalWaitBudgetMs ?? Math.max(5_000, runtime.rateLimitTotalWaitMs),
      ),
    ),
  );
  const provider = providerBucketForTarget(opts);
  const providerLabel = providerDisplayName(provider);
  const keys = splitApiKeys(opts.apiKey);
  if (keys.length === 0) throw new Error('LLM API key is required');
  const lineage: AttemptLineage = opts.attemptLineage ?? {};
  const coordinator = opts.dependencies?.admission ?? currentProviderCoordinator();
  let sleptMs = 0;
  let lastError: Error | undefined;
  let waitRetries = 0;
  let lastLane = provider;
  const triedLanes = new Set<string>();
  const tpmPolicy = tpmPolicyForCall(provider, runtime, system, user, opts.maxTokens);
  while (true) {
    throwIfCancelled(opts.signal);
    const tpm = tpmPolicy ? { ...tpmPolicy, reservationId: randomUUID() } : undefined;
    let selection = await selectProviderKey(provider, keys, keyCursor++, coordinator, tpm);
    // Never dispatch Luna/Flash/MiniMax without a reservation. A key near its
    // rolling TPM ceiling is skipped; when every key is near the cap we stall
    // until the minute drains instead of sending a 429.
    while (tpm && selection.tpmReserved !== true) {
      if (sleptMs + 2_000 > totalWaitBudgetMs) {
        throw new Error(
          selection.cooldownMs > 0
            ? `429 ${providerLabel} account cooldown active across ${keys.length} account(s); retry-after: ${Math.max(1, Math.ceil(selection.cooldownMs / 1000))}`
            : `429 ${providerLabel} TPM ${tpm.budget}/min exhausted across ${keys.length} account(s); retry-after: 60`,
        );
      }
      const waitMs = selection.cooldownMs > 0 ? Math.min(selection.cooldownMs, 2_000) : 2_000;
      const used = selection.tpmUsed ?? 0;
      const pct = tpm.budget > 0 ? Math.min(100, Math.round((used / tpm.budget) * 100)) : 100;
      console.warn(
        selection.cooldownMs > 0
          ? `[llm] ${providerLabel} TPM: ${selection.lane} is cooling (${Math.ceil(selection.cooldownMs / 1000)}s) — waiting before reserving`
          : `[llm] ${providerLabel} TPM: near limit on ${keys.length} account(s) (${pct}% of ${tpm.budget}/min used on ${selection.lane}) — stalling until free room`,
      );
      await sleep(waitMs, opts.signal, clockFor(opts));
      sleptMs += waitMs;
      selection = await selectProviderKey(provider, keys, keyCursor++, coordinator, {
        ...tpm,
        reservationId: randomUUID(),
      });
    }
    lastLane = selection.lane;
    triedLanes.add(selection.lane);
    let enteredProviderCall = false;
    let succeeded = false;
    const tpmSession: TpmSession = {
      lease:
        selection.tpmReserved && selection.reservationId
          ? { lane: selection.lane, reservationId: selection.reservationId }
          : null,
      billed: 0,
      async flush(actualTokens) {
        if (!this.lease) return;
        await commitProviderTpm(
          {
            lane: this.lease.lane,
            reservationId: this.lease.reservationId,
            actualTokens: Math.max(0, Math.floor(actualTokens)),
            windowMs: tpmPolicy?.windowMs,
          },
          coordinator,
        );
        this.lease = null;
        this.billed = 0;
      },
      attach(lease) {
        this.lease = lease;
        this.billed = 0;
      },
    };
    try {
      const output = await withProviderCallSlot(
        provider,
        () => {
          enteredProviderCall = true;
          return llmChatHoldingProviderSlot(
            system,
            user,
            {
              ...opts,
              apiKey: selection.apiKey,
              onUsage: (usage) => {
                tpmSession.billed +=
                  Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
                opts.onUsage?.(usage);
              },
            },
            lineage,
            {
              apiKey: selection.apiKey,
              keyIndex: selection.keyIndex,
              lane: selection.lane,
            },
            {
              provider,
              keys,
              coordinator,
              tpm: tpmPolicy,
              tpmSession,
            },
          );
        },
        opts.signal,
        coordinator,
        { keyLane: selection.lane },
      );
      succeeded = true;
      return output;
    } catch (error) {
      lastError =
        opts.signal?.aborted && !isReviewCancelledError(error)
          ? new ReviewCancelledError()
          : (error as Error);
      if (!enteredProviderCall) recordProviderAdmissionFailure(opts, lineage, lastError);
      if (isReviewCancelledError(lastError) || opts.signal?.aborted)
        throw new ReviewCancelledError();
      // Admission misses are requeued by the executor; do not burn the short
      // provider rate-limit wait budget retrying into a saturated fleet.
      if (!enteredProviderCall && isProviderAdmissionError(lastError.message)) throw lastError;
      if (lastError instanceof DeepSeekContinuationRequiredError) {
        // Continuations are handled inside the held slot; surfacing here is a bug.
        throw lastError;
      }
      // Errors that already consumed the held-slot continuation path must not
      // restart the expensive primary attempt under a fresh admission.
      if (
        /continuation rate-limited|response remained truncated|bounded prefix continuation|JSON contract mismatch/i.test(
          lastError.message,
        )
      ) {
        throw lastError;
      }
      const retryableEmptyResponse = isRetryableEmptyProviderResponse(lastError.message);
      const retryable429 = isRetryableRateLimit(lastError.message);
      const tpmWindow = retryable429 && isTpmWindowError(lastError.message);
      if (!retryable429 && !retryableEmptyResponse) throw lastError;
      const advertised = parseRetryAfterMs(lastError.message);
      const cooldownMs = Math.min(
        300_000,
        Math.max(2_000, advertised ?? baseMs * 2 ** waitRetries),
      );
      await setProviderCooldown(selection.lane, cooldownMs, coordinator);

      const alternate =
        keys.length > 1 ? await selectProviderKey(provider, keys, keyCursor, coordinator) : null;
      const siblingCool =
        alternate !== null &&
        alternate.lane !== selection.lane &&
        alternate.cooldownMs <= 0 &&
        triedLanes.size < keys.length;

      // Multi-key 429: walk every remaining cool account immediately. Holding
      // a worker while one account's TPM window recovers is worse than using
      // the next account. Empty-response rotates at most once.
      if (
        alternate &&
        siblingCool &&
        (retryable429 || (retryableEmptyResponse && waitRetries === 0))
      ) {
        console.warn(
          `[llm] ${retryableEmptyResponse ? 'empty zero-usage response' : 'rate-limited'} on ${selection.lane} — rotating to cool key ${alternate.lane} (${triedLanes.size}/${keys.length} keys tried)`,
        );
        if (retryableEmptyResponse) waitRetries++;
        continue;
      }

      // Generic multi-key 429 fails over to a job requeue. A rolling TPM window
      // is recoverable in-process: pause until the minute drains, then resume.
      if (retryable429 && !tpmWindow && triedLanes.size >= keys.length && keys.length > 1) {
        console.warn(
          `[llm] rate-limited on every ${provider} key (${keys.length}) — failing so the job requeues instead of waiting on a hot account`,
        );
        throw rateLimitAdmissionError(provider, keys.length, lastError);
      }

      waitRetries++;
      if (!tpmWindow && waitRetries >= waitRetryCeiling) {
        throw retryable429 ? rateLimitAdmissionError(provider, keys.length, lastError) : lastError;
      }
      if (!tpmWindow && advertised !== undefined && advertised > maxWaitMs) {
        console.warn(
          `[llm] rate limit window ${Math.round(advertised / 1000)}s exceeds max wait ${Math.round(maxWaitMs / 1000)}s — failing fast instead of retrying into it`,
        );
        throw retryable429 ? rateLimitAdmissionError(provider, keys.length, lastError) : lastError;
      }
      const backoff = Math.min(baseMs * 2 ** Math.max(0, waitRetries - 1), maxWaitMs);
      const jitter = Math.floor(Math.random() * 1_000);
      const waitMs = rateLimitRetryWaitMs(lastError.message, backoff + jitter, maxWaitMs);
      const neededMs = tpmWindow ? Math.max(waitMs, 2_000) : waitMs;
      if (sleptMs + neededMs > totalWaitBudgetMs) {
        console.warn(
          `[llm] ${tpmWindow ? 'TPM' : 'rate-limit'} wait budget exhausted (${Math.round(sleptMs / 1000)}s slept of ${Math.round(totalWaitBudgetMs / 1000)}s) — failing so the job requeues instead of holding a worker slot`,
        );
        throw retryable429 ? rateLimitAdmissionError(provider, keys.length, lastError) : lastError;
      }
      sleptMs += neededMs;
      console.warn(
        `[llm] ${retryableEmptyResponse ? 'empty zero-usage response' : tpmWindow ? 'TPM window' : 'rate-limited'} — holding ${Math.round(neededMs / 1000)}s then retrying when free (attempt ${waitRetries}${tpmWindow ? '' : `/${waitRetryCeiling}`}): ${lastError.message.slice(0, 140)}`,
      );
      await sleep(neededMs, opts.signal, clockFor(opts));
      await waitForProviderAvailability([lastLane], opts.signal, coordinator);
    } finally {
      const actual =
        tpmSession.billed > 0 ? tpmSession.billed : succeeded ? (tpmPolicy?.reserveTokens ?? 0) : 0;
      await tpmSession.flush(actual);
    }
  }
  throw lastError ?? new Error('LLM API key is required');
}
