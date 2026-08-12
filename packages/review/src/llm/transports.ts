import Anthropic from '@anthropic-ai/sdk';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import type { LlmClientDependencies, LlmClientOptions } from './contracts.js';
import { ReviewCancelledError, linkAbortSignal, throwIfCancelled } from './cancellation.js';
import {
  clockFor,
  estimateTokens,
  maxTotalMs,
  providerName,
  resolveMaxOutputTokens,
  thinkingEnabled,
} from './support.js';
import { extractJsonLoose, jsonFinishPrefix, stripThinking } from './parsing.js';
import { RETRYABLE_EMPTY_PROVIDER_RESPONSE } from './retry-policy.js';

// Retain the original initialization behaviour for compatible-chat providers:
// a malformed runtime value is normalized by the config loader before a stream
// is ever opened, rather than producing a timer that fires immediately.
const COMPATIBLE_CHAT_INACTIVITY_MS = loadReviewRuntimeConfig().llmTimeoutMs;

/** Absolute paid-call ceiling; progress grace cannot exceed this. */
const ABSOLUTE_LLM_WALL_CAP_MS = 900_000;
/** Extra wall time granted while a live stream keeps emitting bytes/events. */
const PROGRESS_GRACE_MS = 180_000;

function resolveHardLimitMs(opts: LlmClientOptions): number {
  return Math.min(opts.hardLimitMs ?? maxTotalMs(), ABSOLUTE_LLM_WALL_CAP_MS);
}

export class DeepSeekContinuationRequiredError extends Error {
  constructor(readonly continuation: NonNullable<LlmClientOptions['compatibleContinuation']>) {
    super('LLM max-reasoning response requires bounded prefix continuation');
    this.name = 'DeepSeekContinuationRequiredError';
  }
}

function combineContinuationText(prefix: string, streamedText: string): string {
  if (!prefix || streamedText.startsWith(prefix)) return streamedText;
  try {
    extractJsonLoose(streamedText);
    return streamedText;
  } catch {
    return `${prefix}${streamedText}`;
  }
}

function abortError(
  error: unknown,
  signal: AbortSignal | undefined,
  controller: AbortController,
  timeoutReason: 'inactivity' | 'hard' | undefined,
  hardLimitMs: number,
  inactivityMessage: string,
  hardMessage: string,
): never {
  if (signal?.aborted) throw new ReviewCancelledError();
  if ((error as Error).name === 'AbortError' || controller.signal.aborted) {
    if (timeoutReason === 'hard') throw new Error(hardMessage.replace('%d', String(hardLimitMs)));
    throw new Error(inactivityMessage);
  }
  throw error;
}

interface WatchableAnthropicStream<T> {
  finalMessage(): Promise<T>;
  abort(): void;
  on(event: 'streamEvent', listener: () => void): unknown;
  off?(event: 'streamEvent', listener: () => void): unknown;
}

type AnthropicStream = ReturnType<
  NonNullable<LlmClientDependencies['anthropic']>['messages']['stream']
>;

/**
 * The Anthropic SDK owns its fetch controller, so its inactivity watchdog must
 * observe SDK stream events rather than wrapping an HTTP reader. Keep it
 * separate from the 300-second SDK wall timeout: an open but silent stream is
 * still a failed review attempt.
 */
export async function awaitAnthropicFinalMessage<T>(
  stream: WatchableAnthropicStream<T>,
  opts: LlmClientOptions,
): Promise<T> {
  const clock = clockFor(opts);
  const hardLimitMs = resolveHardLimitMs(opts);
  const absoluteCapMs = ABSOLUTE_LLM_WALL_CAP_MS;
  const inactivityMs = loadReviewRuntimeConfig().llmTimeoutMs;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutReason: 'inactivity' | 'hard' | undefined;
  let cancelled = false;
  let settled = false;
  let lastProgressAt = clock.now();
  const startedAt = clock.now();
  const absoluteDeadlineAt = startedAt + absoluteCapMs;
  let deadlineAt = startedAt + hardLimitMs;
  let sawStreamProgress = false;

  const clearTimers = () => {
    if (inactivityTimer) clock.clearTimeout(inactivityTimer);
    if (hardTimer) clock.clearTimeout(hardTimer);
  };
  const abortStream = () => {
    if (!settled) stream.abort();
  };
  const armInactivity = () => {
    if (settled || timeoutReason) return;
    if (inactivityTimer) clock.clearTimeout(inactivityTimer);
    inactivityTimer = clock.setTimeout(() => {
      timeoutReason = 'inactivity';
      abortStream();
    }, inactivityMs);
  };
  const armHardDeadline = () => {
    if (hardTimer) clock.clearTimeout(hardTimer);
    const remaining = Math.max(1, deadlineAt - clock.now());
    hardTimer = clock.setTimeout(() => {
      const sinceProgress = clock.now() - lastProgressAt;
      if (
        sawStreamProgress &&
        hardLimitMs >= 30_000 &&
        sinceProgress < inactivityMs &&
        deadlineAt < absoluteDeadlineAt
      ) {
        deadlineAt = Math.min(absoluteDeadlineAt, deadlineAt + PROGRESS_GRACE_MS);
        console.warn(
          `[llm] anthropic stream still progressing; extending hard wall to ${Math.round((deadlineAt - clock.now()) / 1000)}s remaining (cap ${Math.round(absoluteCapMs / 1000)}s)`,
        );
        armHardDeadline();
        return;
      }
      timeoutReason = 'hard';
      abortStream();
    }, remaining);
  };
  const onActivity = () => {
    sawStreamProgress = true;
    lastProgressAt = clock.now();
    armInactivity();
  };
  const cancelStream = () => {
    cancelled = true;
    abortStream();
  };

  stream.on('streamEvent', onActivity);
  opts.signal?.addEventListener('abort', cancelStream, { once: true });
  if (opts.signal?.aborted) cancelStream();
  armInactivity();
  armHardDeadline();
  try {
    const response = await stream.finalMessage();
    if (cancelled || opts.signal?.aborted) throw new ReviewCancelledError();
    if (timeoutReason === 'hard')
      throw new Error(`LLM anthropic call exceeded ${hardLimitMs}ms wall-clock cap`);
    if (timeoutReason === 'inactivity')
      throw new Error(`LLM anthropic stream stalled (no data for ${inactivityMs}ms)`);
    return response;
  } catch (error) {
    if (cancelled || opts.signal?.aborted) throw new ReviewCancelledError();
    if (timeoutReason === 'hard')
      throw new Error(`LLM anthropic call exceeded ${hardLimitMs}ms wall-clock cap`);
    if (timeoutReason === 'inactivity')
      throw new Error(`LLM anthropic stream stalled (no data for ${inactivityMs}ms)`);
    throw error;
  } finally {
    settled = true;
    clearTimers();
    stream.off?.('streamEvent', onActivity);
    opts.signal?.removeEventListener('abort', cancelStream);
  }
}

async function openStream(
  url: string,
  body: Record<string, unknown>,
  opts: LlmClientOptions,
  inactivityMs: number,
  labels: { request: string; stream: string },
  onEvent: (data: string) => void,
): Promise<void> {
  throwIfCancelled(opts.signal);
  const clock = clockFor(opts);
  const hardLimitMs = resolveHardLimitMs(opts);
  const absoluteCapMs = ABSOLUTE_LLM_WALL_CAP_MS;
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(opts.signal, controller);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutReason: 'inactivity' | 'hard' | undefined;
  let lastProgressAt = clock.now();
  const startedAt = clock.now();
  const absoluteDeadlineAt = startedAt + absoluteCapMs;
  let deadlineAt = startedAt + hardLimitMs;
  let sawStreamProgress = false;
  const armTimer = () => {
    lastProgressAt = clock.now();
    if (timer) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timeoutReason = 'inactivity';
      controller.abort();
    }, inactivityMs);
  };
  const clearTimers = () => {
    if (timer) clock.clearTimeout(timer);
    if (hardTimer) clock.clearTimeout(hardTimer);
  };
  const armHardDeadline = () => {
    if (hardTimer) clock.clearTimeout(hardTimer);
    const remaining = Math.max(1, deadlineAt - clock.now());
    hardTimer = clock.setTimeout(() => {
      const sinceProgress = clock.now() - lastProgressAt;
      if (
        sawStreamProgress &&
        hardLimitMs >= 30_000 &&
        sinceProgress < inactivityMs &&
        deadlineAt < absoluteDeadlineAt
      ) {
        deadlineAt = Math.min(absoluteDeadlineAt, deadlineAt + PROGRESS_GRACE_MS);
        console.warn(
          `[llm] ${labels.stream} stream still progressing; extending hard wall (${Math.round((deadlineAt - clock.now()) / 1000)}s remaining, cap ${Math.round(absoluteCapMs / 1000)}s)`,
        );
        armHardDeadline();
        return;
      }
      timeoutReason = 'hard';
      controller.abort();
    }, remaining);
  };
  armTimer();
  armHardDeadline();
  let response: Response;
  try {
    response = await (opts.dependencies?.http?.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    clearTimers();
    unlinkAbort();
    abortError(
      error,
      opts.signal,
      controller,
      timeoutReason,
      hardLimitMs,
      labels.request,
      `LLM ${labels.stream} call exceeded %dms wall-clock cap`,
    );
  }
  if (!response.ok || !response.body) {
    const errorBody = response.ok ? 'no response body' : await response.text().catch(() => '');
    clearTimers();
    unlinkAbort();
    const failurePrefix =
      labels.stream === 'chat' ? 'LLM request failed' : `LLM ${labels.stream} request failed`;
    throw new Error(`${failurePrefix} (${response.status}): ${errorBody.slice(0, 500)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatchLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data && data !== '[DONE]') onEvent(data);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sawStreamProgress = true;
      armTimer();
      if (clock.now() > deadlineAt) {
        if (
          hardLimitMs >= 30_000 &&
          deadlineAt < absoluteDeadlineAt &&
          clock.now() - lastProgressAt < inactivityMs
        ) {
          deadlineAt = Math.min(absoluteDeadlineAt, deadlineAt + PROGRESS_GRACE_MS);
          armHardDeadline();
        } else {
          try {
            await reader.cancel();
          } catch {
            /* best effort */
          }
          throw new Error(`LLM ${labels.stream} call exceeded ${hardLimitMs}ms wall-clock cap`);
        }
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) dispatchLine(raw);
    }
    buffer += decoder.decode();
    if (buffer) dispatchLine(buffer);
  } catch (error) {
    abortError(
      error,
      opts.signal,
      controller,
      timeoutReason,
      hardLimitMs,
      labels.stream === 'responses'
        ? `LLM responses stream stalled (no data for ${inactivityMs}ms)`
        : `LLM stream stalled (no data for ${inactivityMs}ms)`,
      `LLM ${labels.stream} call exceeded %dms wall-clock cap`,
    );
  } finally {
    clearTimers();
    unlinkAbort();
  }
}

export async function anthropicChat(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  throwIfCancelled(opts.signal);
  const hardLimitMs = resolveHardLimitMs(opts);
  const client = (opts.dependencies?.anthropic ??
    new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      timeout: hardLimitMs,
    })) as {
    messages: {
      stream(params: Record<string, unknown>): AnthropicStream;
    };
  };
  const maxTokens = resolveMaxOutputTokens(opts.maxTokens);
  const continuation = opts.compatibleContinuation;
  const continuationPrefix = continuation?.contentPrefix ?? '';
  const think = thinkingEnabled(opts) && maxTokens >= 16_000 && !continuation;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  const prefillBareObject = opts.json && !think && !continuationPrefix;
  if (continuationPrefix) messages.push({ role: 'assistant', content: continuationPrefix });
  else if (prefillBareObject) messages.push({ role: 'assistant', content: '{' });
  const configuredThinkingBudget = loadReviewRuntimeConfig().anthropicThinkingBudgetTokens;
  const thinkingBudget = resolveAnthropicThinkingBudget(
    opts.model,
    maxTokens,
    configuredThinkingBudget,
  );
  const stream = client.messages.stream({
    model: opts.model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(think ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } } : {}),
    ...(!think && opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  });
  const startedAt = Date.now();
  const response = await awaitAnthropicFinalMessage(stream, opts);
  if (response.usage)
    opts.onUsage?.({
      inputTokens: response.usage.input_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
      tokenSource: 'provider',
      provider: providerName(opts.baseUrl, opts.api),
      model: opts.model,
    });
  const textBlock = response.content.find((block) => block.type === 'text');
  const rawText = textBlock && textBlock.type === 'text' ? (textBlock.text ?? '') : '';
  const text = continuationPrefix
    ? combineContinuationText(continuationPrefix, rawText)
    : prefillBareObject
      ? `{${rawText}`
      : rawText;
  const reasoningChars = response.content.reduce((total, block) => {
    if (block.type !== 'thinking') return total;
    const thinking = 'thinking' in block ? String(block.thinking ?? '') : '';
    return total + thinking.length;
  }, 0);
  console.log(
    `[llm] model=${opts.model} api=anthropic thinking=${think ? 'on' : 'off'} reasoning=${reasoningChars}c answer=${text.length}c ${Math.round((Date.now() - startedAt) / 1000)}s stop=${response.stop_reason ?? 'end_turn'}`,
  );
  if (response.stop_reason === 'max_tokens') {
    if (opts.json) {
      throw new DeepSeekContinuationRequiredError({
        reasoningContent: continuation?.reasoningContent ?? '',
        contentPrefix: text || jsonFinishPrefix(rawText),
      });
    }
    throw new Error('LLM response truncated (stop_reason=max_tokens); increase max tokens');
  }
  if (!text) {
    if (response.usage?.input_tokens === 0 && response.usage.output_tokens === 0)
      throw new Error(RETRYABLE_EMPTY_PROVIDER_RESPONSE);
    throw new Error('LLM returned no text content');
  }
  return text;
}

export function resolveAnthropicThinkingBudget(
  model: string,
  maxTokens: number,
  configured: number | undefined,
): number {
  const miniMax = model.startsWith('MiniMax-');
  const defaultBudget = miniMax ? 6_000 : 32_000;
  const requested =
    configured !== undefined && Number.isFinite(configured) && configured > 0
      ? configured
      : defaultBudget;
  const providerBudget = miniMax ? 6_000 : requested;
  return Math.max(1_024, Math.min(requested, providerBudget, maxTokens - 8_000));
}

export async function openAiResponsesStreamChat(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  const clock = clockFor(opts);
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const timeoutMs = loadReviewRuntimeConfig().responsesTimeoutMs;
  const effort = opts.reasoningEffort ?? loadReviewRuntimeConfig().openAiReasoningEffort;
  let content = '';
  let reasoningTokens = 0;
  let inTok = 0;
  let cachedInTok = 0;
  let cacheWriteTok = 0;
  let outTok = 0;
  let failed: string | undefined;
  let incomplete: string | undefined;
  const startedAt = clock.now();
  await openStream(
    `${base}/responses`,
    {
      model: opts.model,
      instructions: system,
      input: user,
      ...(thinkingEnabled(opts) ? { reasoning: { effort } } : {}),
      max_output_tokens: resolveMaxOutputTokens(opts.maxTokens),
      stream: true,
      ...(opts.json ? { text: { format: { type: 'json_object' } } } : {}),
    },
    opts,
    timeoutMs,
    { request: `LLM responses request stalled (no data for ${timeoutMs}ms)`, stream: 'responses' },
    (data) => {
      try {
        const event = JSON.parse(data) as {
          type?: string;
          delta?: string;
          response?: {
            incomplete_details?: { reason?: string };
            error?: { message?: string };
            usage?: {
              input_tokens?: number;
              input_tokens_details?: {
                cached_tokens?: number;
                cache_write_tokens?: number;
                cache_creation_tokens?: number;
              };
              output_tokens?: number;
              output_tokens_details?: { reasoning_tokens?: number };
            };
          };
          message?: string;
        };
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string')
          content += event.delta;
        else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          const usage = event.response?.usage;
          if (usage) {
            inTok = usage.input_tokens ?? 0;
            cachedInTok = usage.input_tokens_details?.cached_tokens ?? 0;
            cacheWriteTok =
              usage.input_tokens_details?.cache_write_tokens ??
              usage.input_tokens_details?.cache_creation_tokens ??
              0;
            outTok = usage.output_tokens ?? 0;
            reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
          }
          if (event.type === 'response.incomplete')
            incomplete = event.response?.incomplete_details?.reason ?? 'incomplete';
        } else if (event.type === 'response.failed' || event.type === 'error')
          failed = event.response?.error?.message ?? event.message ?? 'response failed';
      } catch {
        /* partial/keepalive line */
      }
    },
  );
  console.log(
    `[llm] model=${opts.model} api=responses effort=${effort} reasoning=${reasoningTokens}tok answer=${content.length}c ${Math.round((clock.now() - startedAt) / 1000)}s`,
  );
  opts.onUsage?.({
    inputTokens: inTok || estimateTokens(system.length + user.length),
    cachedInputTokens: inTok ? Math.min(inTok, cachedInTok) : 0,
    cacheWriteTokens: inTok ? Math.min(Math.max(0, inTok - cachedInTok), cacheWriteTok) : 0,
    outputTokens: outTok || estimateTokens(content.length),
    tokenSource: inTok && outTok ? 'provider' : 'estimate',
    provider: providerName(opts.baseUrl, opts.api),
    model: opts.model,
  });
  if (failed) throw new Error(`LLM responses stream failed: ${failed}`);
  if (incomplete)
    throw new Error(`LLM responses truncated (${incomplete}); increase ORVEX_MAX_OUTPUT_TOKENS`);
  if (!content) {
    if (inTok === 0 && outTok === 0) throw new Error(RETRYABLE_EMPTY_PROVIDER_RESPONSE);
    throw new Error('LLM responses returned no text');
  }
  return content;
}

export async function openAiCompatStreamChat(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  const clock = clockFor(opts);
  const inactivityMs = COMPATIBLE_CHAT_INACTIVITY_MS;
  let content = '';
  let reasoningContent = '';
  let finishReason: string | undefined;
  let providerUsage:
    | { inputTokens: number; cachedInputTokens: number; outputTokens: number }
    | undefined;
  const requestSystem =
    opts.json && opts.reasoningEffort === 'max' && /deepseek-v4/i.test(opts.model)
      ? `${system}\n\n## Completion contract\nReasoning effort is fixed at max by the API. Finish private reasoning within 18,000 tokens and reserve the remaining response budget for the final JSON. Emit the JSON immediately when the evidence is sufficient.`
      : system;
  const continuation = opts.compatibleContinuation;
  const continuationPrefix = continuation?.contentPrefix ?? '';
  const deepseekPrefix = Boolean(continuation && supportsCompatibleUsageStream(opts.baseUrl));
  const continuationMessages = !continuation
    ? []
    : deepseekPrefix
      ? [
          {
            role: 'assistant',
            content: continuationPrefix,
            reasoning_content: continuation.reasoningContent,
            prefix: true,
          },
        ]
      : [
          { role: 'assistant', content: continuationPrefix },
          {
            role: 'user',
            content:
              'Complete the JSON object now. Return only valid JSON for the review contract. No markdown or reasoning.',
          },
        ];
  const requestChars =
    requestSystem.length +
    user.length +
    (continuation?.reasoningContent.length ?? 0) +
    continuationPrefix.length;
  const baseUrl = opts.baseUrl!.replace(/\/$/, '');
  const requestUrl = deepseekPrefix
    ? `${new URL('/beta', `${baseUrl}/`).toString().replace(/\/$/, '')}/chat/completions`
    : `${baseUrl}/chat/completions`;
  const startedAt = clock.now();
  try {
    await openStream(
      requestUrl,
      {
        model: opts.model,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        max_tokens: resolveMaxOutputTokens(opts.maxTokens),
        stream: true,
        ...(supportsCompatibleUsageStream(opts.baseUrl)
          ? { stream_options: { include_usage: true } }
          : {}),
        ...(opts.json && !deepseekPrefix ? { response_format: { type: 'json_object' } } : {}),
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
        ...(supportsCompatibleUsageStream(opts.baseUrl)
          ? { thinking: { type: thinkingEnabled(opts) ? 'enabled' : 'disabled' } }
          : {
              chat_template_kwargs: {
                thinking_mode: thinkingEnabled(opts) ? 'enabled' : 'disabled',
              },
            }),
        messages: [
          { role: 'system', content: requestSystem },
          { role: 'user', content: user },
          ...continuationMessages,
        ],
      },
      opts,
      inactivityMs,
      { request: `LLM request stalled (no data for ${inactivityMs}ms)`, stream: 'chat' },
      (data) => {
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              finish_reason?: string | null;
              native_finish_reason?: string | null;
              delta?: {
                content?: string | null;
                reasoning_content?: string | null;
                reasoning?: string | null;
              };
            }>;
            usage?: {
              prompt_tokens?: number;
              prompt_cache_hit_tokens?: number;
              completion_tokens?: number;
            } | null;
          };
          const usage = chunk.usage;
          if (
            usage &&
            Number.isFinite(usage.prompt_tokens) &&
            Number.isFinite(usage.completion_tokens)
          ) {
            const inputTokens = Math.max(0, usage.prompt_tokens ?? 0);
            providerUsage = {
              inputTokens,
              cachedInputTokens: Math.min(
                inputTokens,
                Math.max(0, usage.prompt_cache_hit_tokens ?? 0),
              ),
              outputTokens: Math.max(0, usage.completion_tokens ?? 0),
            };
          }
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) content += choice.delta.content;
          if (choice?.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
          if (choice?.delta?.reasoning) reasoningContent += choice.delta.reasoning;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (choice?.native_finish_reason && choice.native_finish_reason !== 'completed')
            finishReason = choice.native_finish_reason;
        } catch {
          /* partial/keepalive line */
        }
      },
    );
  } catch (error) {
    const streamedChars = reasoningContent.length + content.length;
    if (streamedChars > 0) {
      opts.onUsage?.({
        inputTokens: estimateTokens(requestChars),
        cachedInputTokens: 0,
        outputTokens: estimateTokens(streamedChars),
        tokenSource: 'estimate',
        provider: providerName(opts.baseUrl, opts.api),
        model: opts.model,
      });
    }
    if (
      streamedChars > 0 &&
      supportsCompatibleUsageStream(opts.baseUrl) &&
      opts.json &&
      opts.reasoningEffort === 'max' &&
      /deepseek-v4/i.test(opts.model) &&
      (thinkingEnabled(opts) || Boolean(continuation)) &&
      /terminated|premature(?:ly)? closed|other side closed/i.test(
        (error as Error)?.message ?? String(error),
      )
    ) {
      const streamedText = stripThinking(content);
      const contentPrefix = continuationPrefix
        ? combineContinuationText(continuationPrefix, streamedText)
        : streamedText || '{"findings":';
      throw new DeepSeekContinuationRequiredError({
        reasoningContent: `${continuation?.reasoningContent ?? ''}${reasoningContent}`,
        contentPrefix,
      });
    }
    throw error;
  }
  const inlineThinkChars = (content.match(/<think>[\s\S]*?<\/think>/gi) ?? []).reduce(
    (total, block) => total + block.length,
    0,
  );
  const totalReasoning = reasoningContent.length + inlineThinkChars;
  const streamedText = stripThinking(content);
  const text = continuationPrefix
    ? combineContinuationText(continuationPrefix, streamedText)
    : streamedText;
  const answerChars = text.length;
  console.log(
    `[llm] model=${opts.model} thinking=${thinkingEnabled(opts) ? 'on' : 'off'} reasoning=${totalReasoning}c answer=${answerChars}c ${Math.round((clock.now() - startedAt) / 1000)}s finish=${finishReason ?? 'stop'}`,
  );
  opts.onUsage?.(
    providerUsage
      ? {
          ...providerUsage,
          tokenSource: 'provider',
          provider: providerName(opts.baseUrl, opts.api),
          model: opts.model,
        }
      : {
          inputTokens: estimateTokens(requestChars),
          cachedInputTokens: 0,
          outputTokens: estimateTokens(totalReasoning + streamedText.length),
          tokenSource: 'estimate',
          provider: providerName(opts.baseUrl, opts.api),
          model: opts.model,
        },
  );
  if (finishReason === 'length') {
    if (opts.json && (thinkingEnabled(opts) || Boolean(continuation))) {
      throw new DeepSeekContinuationRequiredError({
        reasoningContent: `${continuation?.reasoningContent ?? ''}${reasoningContent}`,
        contentPrefix: text || jsonFinishPrefix(streamedText),
      });
    }
    throw new Error('LLM response truncated (finish_reason=length); increase max tokens');
  }
  if (!text) throw new Error('LLM returned no text content');
  return text;
}

function supportsCompatibleUsageStream(baseUrl: string | undefined): boolean {
  try {
    return new URL(baseUrl ?? '').hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

export async function llmChatSingle(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  if (opts.api === 'anthropic') return anthropicChat(system, user, opts);
  if (opts.api === 'responses') return openAiResponsesStreamChat(system, user, opts);
  if (opts.baseUrl) return openAiCompatStreamChat(system, user, opts);
  return anthropicChat(system, user, opts);
}
