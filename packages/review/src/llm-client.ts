import Anthropic from '@anthropic-ai/sdk';

export interface LlmClientOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint (e.g. MiniMax); omit to use the Anthropic SDK */
  baseUrl?: string;
  maxTokens?: number;
  /** ask the provider for a JSON object response where supported */
  json?: boolean;
  /** force-disable reasoning for this call (default: reasoning ON) */
  thinking?: boolean;
  /**
   * Called once per completed call with token usage, for cost tracking. Anthropic
   * reports exact usage; the OpenAI-compatible/streaming path estimates from
   * character counts (~4 chars/token) since it doesn't request a usage object.
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

/** Rough chars→tokens estimate (~4 chars/token) for providers that don't return
 *  a usage object on the streaming path. Approximate but good enough for cost
 *  visibility / spend alerting. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

/** Hard ceiling on any single LLM call so a hung provider can't wedge a job. */
const LLM_TIMEOUT_MS = Number(process.env.ORVEX_LLM_TIMEOUT_MS ?? 240_000);

/** Reasoning models think before answering — slower, materially more accurate. */
function thinkingEnabled(opts: LlmClientOptions): boolean {
  if (opts.thinking !== undefined) return opts.thinking;
  return process.env.ORVEX_LLM_THINKING !== '0';
}

/**
 * One chat call, either provider:
 * - `baseUrl` set → OpenAI-compatible `/chat/completions` (MiniMax, etc.)
 * - otherwise → Anthropic SDK
 */

/**
 * True for a provider rate-limit / quota-exhaustion error specifically —
 * deliberately narrower than `isTransientLlmError` (packages/review/src/llm.ts),
 * which also matches generic network blips (timeouts, ECONNRESET, "fetch
 * failed"). That distinction is intentional: a transient network hiccup on the
 * PRIMARY provider is usually worth retrying on the SAME provider, not grounds
 * to switch providers entirely — but an actual quota/rate-limit signal means
 * the primary is genuinely unavailable, which IS grounds to fail over.
 * Exported so it's independently unit-tested rather than a silent duplicate.
 */
export function isRateLimitOrQuotaError(message: string): boolean {
  return /\b429\b|rate.?limit|usage limit|quota|token plan|insufficient/i.test(message);
}

export async function llmChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  if (opts.baseUrl) {
    try {
      return await openAiCompatStreamChat(system, user, opts);
    } catch (err) {
      // Automatic provider failover: if the primary provider (e.g. MiniMax) is
      // rate-limited or out of quota, retry on a configured fallback so a
      // quota-out never halts reviews. Tries a generic OpenAI-compatible fallback
      // endpoint first (any provider, or a local model), then Anthropic. No-op
      // when neither is configured — single-provider behavior is unchanged.
      if (isRateLimitOrQuotaError((err as Error).message)) {
        const fbUrl = process.env.ORVEX_FALLBACK_BASE_URL;
        if (fbUrl) {
          console.warn('[llm] primary unavailable (rate-limit/quota) — failing over to fallback endpoint');
          return await openAiCompatStreamChat(system, user, {
            ...opts,
            baseUrl: fbUrl,
            apiKey: process.env.ORVEX_FALLBACK_API_KEY ?? opts.apiKey,
            model: process.env.ORVEX_FALLBACK_MODEL ?? opts.model,
          });
        }
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
          console.warn('[llm] primary unavailable (rate-limit/quota) — failing over to Anthropic');
          return await anthropicChat(system, user, {
            ...opts,
            apiKey: anthropicKey,
            baseUrl: undefined,
            model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
          });
        }
      }
      throw err;
    }
  }
  return anthropicChat(system, user, opts);
}

async function anthropicChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: LLM_TIMEOUT_MS });
  // Match the MiniMax branch: stream (so multi-minute reasoning calls keep the
  // socket alive instead of dying as "fetch failed"), think by default, and use
  // a high output ceiling so reasoning + findings with fix blocks never truncate.
  const maxTokens = opts.maxTokens ?? Number(process.env.ORVEX_MAX_OUTPUT_TOKENS ?? 64_000);
  // Extended thinking is incompatible with an assistant prefill and needs real
  // output headroom — only enable it when there's room to think.
  const think = thinkingEnabled(opts) && maxTokens >= 16_000;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  const prefill = opts.json && !think;
  if (prefill) messages.push({ role: 'assistant', content: '{' });
  const stream = client.messages.stream({
    model: opts.model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(think
      ? { thinking: { type: 'enabled' as const, budget_tokens: Math.min(32_000, maxTokens - 8_000) } }
      : {}),
  });
  const response = await stream.finalMessage();
  if (response.usage) {
    opts.onUsage?.({ inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('LLM response truncated (stop_reason=max_tokens); increase max tokens');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content');
  }
  // re-attach the prefilled '{' when JSON mode used a prefill
  return prefill ? `{${textBlock.text}` : textBlock.text;
}

/**
 * Streaming call to an OpenAI-compatible endpoint (MiniMax, etc.).
 *
 * Deep reasoning over a full-repo prompt can run for many minutes; a plain
 * non-streaming POST gets its connection dropped ("fetch failed") long before
 * the answer is ready. Streaming keeps the socket alive with a steady trickle
 * of tokens. The timeout is an INACTIVITY timer (reset on every chunk), so a
 * long-but-progressing reason never aborts — only a truly stalled socket does.
 *
 * No output cap is imposed: `max_completion_tokens` is set to a very high
 * ceiling (the model only emits what it needs), so reasoning + the answer are
 * never truncated. Override with ORVEX_MAX_OUTPUT_TOKENS if ever needed.
 */
async function openAiCompatStreamChat(
  system: string,
  user: string,
  opts: LlmClientOptions,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  };
  armTimer();

  // A generous ceiling so nothing is capped; the model stops at its natural end
  // and only bills for tokens actually generated. Reasoning shares this budget.
  const maxOut = opts.maxTokens ?? Number(process.env.ORVEX_MAX_OUTPUT_TOKENS ?? 128_000);

  let response: Response;
  try {
    response = await fetch(`${opts.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: opts.model,
        max_completion_tokens: maxOut,
        stream: true,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        thinking: { type: thinkingEnabled(opts) ? 'adaptive' : 'disabled' },
        // Return reasoning in a dedicated reasoning_content stream (not inline
        // <think> tags), so the answer parses cleanly and we can measure it.
        reasoning_split: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer!);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`LLM request stalled (no data for ${LLM_TIMEOUT_MS}ms)`);
    }
    throw err;
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer!);
    const errorBody = response.ok ? 'no response body' : await response.text().catch(() => '');
    throw new Error(`LLM request failed (${response.status}): ${errorBody.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = '';
  let content = '';
  let reasoningChars = 0; // separated <think> stream (reasoning_split / M-series)
  let finishReason: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimer(); // progress — reset the inactivity timer
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              finish_reason?: string | null;
              delta?: { content?: string | null; reasoning_content?: string | null };
            }>;
          };
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) content += choice.delta.content;
          if (choice?.delta?.reasoning_content) reasoningChars += choice.delta.reasoning_content.length;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        } catch {
          // partial/keepalive line — ignore, more will arrive
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`LLM stream stalled (no data for ${LLM_TIMEOUT_MS}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer!);
  }

  // Reasoning arrives either as a separate reasoning_content stream OR inline as
  // <think>…</think> in content. Sum both so the log reflects how much the model
  // actually reasoned — this is the ground truth behind "is it deeply thinking?".
  const inlineThinkChars = (content.match(/<think>[\s\S]*?<\/think>/gi) ?? []).reduce((n, b) => n + b.length, 0);
  const totalReasoning = reasoningChars + inlineThinkChars;
  const answerChars = stripThinking(content).length;
  console.log(
    `[llm] model=${opts.model} thinking=${thinkingEnabled(opts) ? 'on' : 'off'} ` +
      `reasoning=${totalReasoning}c answer=${answerChars}c ${Math.round((Date.now() - startedAt) / 1000)}s finish=${finishReason ?? 'stop'}`,
  );
  opts.onUsage?.({
    inputTokens: estimateTokens(system.length + user.length),
    outputTokens: estimateTokens(totalReasoning + answerChars),
  });

  const text = stripThinking(content);
  if (!text) throw new Error('LLM returned no text content');
  if (finishReason === 'length') {
    throw new Error('LLM response truncated (finish_reason=length); increase max tokens');
  }
  return text;
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

/**
 * Pull a JSON payload out of a model reply. Models wrap the object in prose, in
 * a ```json fence, or — for reviews of shell/nginx code — sometimes emit an
 * unrelated ```bash block FIRST (which naive `/```(?:json)?/` extraction would
 * grab and then crash JSON.parse on). Try, in order: an explicit json fence,
 * any fenced block that parses to an object, the outermost {...} span, then the
 * bare text. Throws only when nothing parses, so callers can retry or degrade.
 */
export function extractJsonLoose(text: string): unknown {
  const stripped = stripThinking(text);

  const jsonFence = stripped.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    const parsed = tryParse(jsonFence[1]);
    if (parsed !== undefined) return parsed;
  }

  for (const m of stripped.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)) {
    const parsed = tryParse(m[1]);
    if (parsed && typeof parsed === 'object') return parsed;
  }

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(stripped.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }

  const bare = tryParse(stripped);
  if (bare !== undefined) return bare;

  throw new Error('LLM response contained no parseable JSON');
}
