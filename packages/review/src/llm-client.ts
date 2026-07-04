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

export async function llmChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  if (opts.baseUrl) {
    return openAiCompatStreamChat(system, user, opts);
  }

  const client = new Anthropic({ apiKey: opts.apiKey, timeout: LLM_TIMEOUT_MS });
  // Match the MiniMax branch: JSON mode is steered via the system prompt (which
  // already says "JSON only"); give generous output headroom; nudge JSON with an
  // assistant prefill so the reply starts with '{'.
  const maxTokens = Math.max(opts.maxTokens ?? 4096, 8000);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  if (opts.json) messages.push({ role: 'assistant', content: '{' });
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: maxTokens,
    system,
    messages,
  });
  if (response.stop_reason === 'max_tokens') {
    throw new Error('LLM response truncated (stop_reason=max_tokens); increase max tokens');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content');
  }
  // re-attach the prefilled '{' when JSON mode used a prefill
  return opts.json ? `{${textBlock.text}` : textBlock.text;
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
  let buffer = '';
  let content = '';
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
