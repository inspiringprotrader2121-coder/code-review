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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model,
          // Reasoning burns output tokens before the answer, so give it plenty
          // of headroom or the JSON gets truncated ('Unexpected end of JSON input').
          max_completion_tokens: thinkingEnabled(opts)
            ? Math.max(opts.maxTokens ?? 4096, 40_000)
            : (opts.maxTokens ?? 4096),
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          // MiniMax reasoning: 'adaptive' (think when useful) or 'disabled'
          thinking: { type: thinkingEnabled(opts) ? 'adaptive' : 'disabled' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`LLM request timed out after ${LLM_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${errorBody.slice(0, 500)}`);
    }

    const completion = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string | null; reasoning_content?: string | null };
      }>;
    };
    const choice = completion.choices?.[0];
    const text = choice?.message?.content;
    if (!text) {
      // reasoning-only response with no answer, or empty content
      throw new Error('LLM returned no text content');
    }
    if (choice?.finish_reason === 'length') {
      // ran out of output tokens mid-answer — surface a clear, retryable error
      throw new Error('LLM response truncated (finish_reason=length); increase max tokens');
    }
    return stripThinking(text);
  }

  const client = new Anthropic({ apiKey: opts.apiKey, timeout: LLM_TIMEOUT_MS });
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content');
  }
  return textBlock.text;
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
