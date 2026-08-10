import Anthropic from '@anthropic-ai/sdk';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import type { LlmClientOptions } from './contracts.js';
import { ReviewCancelledError, linkAbortSignal, throwIfCancelled } from './cancellation.js';
import {
  clockFor,
  estimateTokens,
  maxTotalMs,
  providerName,
  resolveMaxOutputTokens,
  thinkingEnabled,
} from './support.js';
import { stripThinking } from './parsing.js';
import { RETRYABLE_EMPTY_PROVIDER_RESPONSE } from './retry-policy.js';

// Retain the original initialization behaviour for compatible-chat providers:
// a malformed runtime value is normalized by the config loader before a stream
// is ever opened, rather than producing a timer that fires immediately.
const COMPATIBLE_CHAT_INACTIVITY_MS = loadReviewRuntimeConfig().llmTimeoutMs;

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
  const hardLimitMs = maxTotalMs();
  const inactivityMs = loadReviewRuntimeConfig().llmTimeoutMs;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutReason: 'inactivity' | 'hard' | undefined;
  let cancelled = false;
  let settled = false;

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
  const onActivity = () => armInactivity();
  const cancelStream = () => {
    cancelled = true;
    abortStream();
  };

  stream.on('streamEvent', onActivity);
  opts.signal?.addEventListener('abort', cancelStream, { once: true });
  if (opts.signal?.aborted) cancelStream();
  armInactivity();
  hardTimer = clock.setTimeout(() => {
    timeoutReason = 'hard';
    abortStream();
  }, hardLimitMs);
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
  const hardLimitMs = maxTotalMs();
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(opts.signal, controller);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutReason: 'inactivity' | 'hard' | undefined;
  const armTimer = () => {
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
  armTimer();
  hardTimer = clock.setTimeout(() => {
    timeoutReason = 'hard';
    controller.abort();
  }, hardLimitMs);
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
  const startedAt = clock.now();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimer();
      if (clock.now() - startedAt > hardLimitMs) {
        try {
          await reader.cancel();
        } catch {
          /* best effort */
        }
        throw new Error(`LLM ${labels.stream} call exceeded ${hardLimitMs}ms wall-clock cap`);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data && data !== '[DONE]') onEvent(data);
      }
    }
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
  const hardLimitMs = maxTotalMs();
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
    timeout: hardLimitMs,
  });
  const maxTokens = resolveMaxOutputTokens(opts.maxTokens);
  const think = thinkingEnabled(opts) && maxTokens >= 16_000;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  const prefill = opts.json && !think;
  if (prefill) messages.push({ role: 'assistant', content: '{' });
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
      outputTokens: response.usage.output_tokens,
      tokenSource: 'provider',
      provider: providerName(opts.baseUrl, opts.api),
      model: opts.model,
    });
  if (response.stop_reason === 'max_tokens')
    throw new Error('LLM response truncated (stop_reason=max_tokens); increase max tokens');
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    if (response.usage?.input_tokens === 0 && response.usage.output_tokens === 0)
      throw new Error(RETRYABLE_EMPTY_PROVIDER_RESPONSE);
    throw new Error('LLM returned no text content');
  }
  const reasoningChars = response.content.reduce(
    (total, block) => total + (block.type === 'thinking' ? block.thinking.length : 0),
    0,
  );
  const text = prefill ? `{${textBlock.text}` : textBlock.text;
  console.log(
    `[llm] model=${opts.model} api=anthropic thinking=${think ? 'on' : 'off'} reasoning=${reasoningChars}c answer=${text.length}c ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
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
  let reasoningChars = 0;
  let finishReason: string | undefined;
  const startedAt = clock.now();
  await openStream(
    `${opts.baseUrl!.replace(/\/$/, '')}/chat/completions`,
    {
      model: opts.model,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      max_tokens: resolveMaxOutputTokens(opts.maxTokens),
      stream: true,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      chat_template_kwargs: { thinking_mode: thinkingEnabled(opts) ? 'enabled' : 'disabled' },
      reasoning_split: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
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
        };
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.delta?.reasoning_content)
          reasoningChars += choice.delta.reasoning_content.length;
        if (choice?.delta?.reasoning) reasoningChars += choice.delta.reasoning.length;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (choice?.native_finish_reason && choice.native_finish_reason !== 'completed')
          finishReason = choice.native_finish_reason;
      } catch {
        /* partial/keepalive line */
      }
    },
  );
  const inlineThinkChars = (content.match(/<think>[\s\S]*?<\/think>/gi) ?? []).reduce(
    (total, block) => total + block.length,
    0,
  );
  const totalReasoning = reasoningChars + inlineThinkChars;
  const answerChars = stripThinking(content).length;
  console.log(
    `[llm] model=${opts.model} thinking=${thinkingEnabled(opts) ? 'on' : 'off'} reasoning=${totalReasoning}c answer=${answerChars}c ${Math.round((clock.now() - startedAt) / 1000)}s finish=${finishReason ?? 'stop'}`,
  );
  opts.onUsage?.({
    inputTokens: estimateTokens(system.length + user.length),
    outputTokens: estimateTokens(totalReasoning + answerChars),
    tokenSource: 'estimate',
    provider: providerName(opts.baseUrl, opts.api),
    model: opts.model,
  });
  const text = stripThinking(content);
  if (finishReason === 'length')
    throw new Error('LLM response truncated (finish_reason=length); increase max tokens');
  if (!text) throw new Error('LLM returned no text content');
  return text;
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
