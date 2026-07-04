import Anthropic from '@anthropic-ai/sdk';

export interface LlmClientOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint (e.g. MiniMax); omit to use the Anthropic SDK */
  baseUrl?: string;
  maxTokens?: number;
  /** ask the provider for a JSON object response where supported */
  json?: boolean;
}

/**
 * One chat call, either provider:
 * - `baseUrl` set → OpenAI-compatible `/chat/completions` (MiniMax, etc.)
 * - otherwise → Anthropic SDK
 */
export async function llmChat(system: string, user: string, opts: LlmClientOptions): Promise<string> {
  if (opts.baseUrl) {
    const response = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        max_completion_tokens: opts.maxTokens ?? 4096,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${errorBody.slice(0, 500)}`);
    }

    const completion = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = completion.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('LLM returned no text content');
    }
    return stripThinking(text);
  }

  const client = new Anthropic({ apiKey: opts.apiKey });
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
