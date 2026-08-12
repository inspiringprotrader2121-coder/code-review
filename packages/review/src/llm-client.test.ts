import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureLlmProviderCoordinator,
  llmChat,
  providerConcurrency,
  ReviewCancelledError,
  setProviderCooldown,
  withProviderCallSlot,
  waitForProviderAvailability,
  type LlmAttemptEvent,
  type LlmProviderCoordinator,
} from './llm-client.js';
import { awaitAnthropicFinalMessage, resolveAnthropicThinkingBudget } from './llm/transports.js';
import { providerCooldownForFailure } from './llm/retry-policy.js';
import type { Clock } from './providers/types.js';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/** Minimal /v1/responses SSE stream carrying one text delta and a completion. */
function responsesStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = [
    JSON.stringify({ type: 'response.output_text.delta', delta: text }),
    JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 10, output_tokens: 5 } },
    }),
  ];
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`));
      controller.close();
    },
  });
}

function emptyZeroUsageResponsesStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { usage: { input_tokens: 0, output_tokens: 0 } },
          })}\n\n`,
        ),
      );
      controller.close();
    },
  });
}

/** Minimal /chat/completions SSE stream. */
function chatStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = [
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

test('compatible streams process a final SSE event without a trailing newline', async () => {
  const encoder = new TextEncoder();
  const result = await llmChat('sys', 'user', {
    apiKey: 'test-key',
    model: 'final-buffer-model',
    baseUrl: 'https://final-buffer.test/v1',
    api: 'chat',
    thinking: false,
    dependencies: {
      http: {
        async fetch() {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }] })}`,
                  ),
                );
                controller.close();
              },
            }),
            { status: 200 },
          );
        },
      },
    },
  });
  assert.equal(result, '{"findings":[]}');
});

function chatStreamWithUsage(
  text: string,
  usage: { prompt_tokens: number; prompt_cache_hit_tokens: number; completion_tokens: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = [
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    JSON.stringify({ choices: [], usage }),
  ];
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function withStubbedFetch(
  stream: (url: string) => ReadableStream<Uint8Array>,
  run: () => Promise<void>,
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = String(input);
    captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(stream(url), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

// gpt-5.x reasoning models reject `temperature` with a 400 rather than ignoring
// it. Sending it made every repeated aggregation sample of the general pass fail
// and degrade to an empty review.
test('the responses API never sends temperature, even when a sample requests one', async () => {
  const captured = await withStubbedFetch(
    () => responsesStream('{"findings":[]}'),
    async () => {
      const out = await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'gpt-5.6-luna',
        baseUrl: 'https://example.test/v1',
        api: 'responses',
        temperature: 0.2,
        thinking: false,
      });
      assert.equal(out, '{"findings":[]}');
    },
  );

  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /\/responses$/);
  assert.equal('temperature' in captured[0].body, false);
  assert.equal(captured[0].body.model, 'gpt-5.6-luna');
});

test('the OpenAI-compatible chat API still honours an explicit sample temperature', async () => {
  const captured = await withStubbedFetch(
    () => chatStream('{"findings":[]}'),
    async () => {
      await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://example.test/v1',
        api: 'chat',
        temperature: 0.2,
        thinking: false,
      });
    },
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.temperature, 0.2);
  assert.equal('stream_options' in captured[0].body, false);
});

test('DeepSeek streaming usage reports cache reads at provider precision', async () => {
  let usage:
    | {
        inputTokens: number;
        cachedInputTokens?: number;
        outputTokens: number;
        tokenSource?: string;
        provider?: string;
        model?: string;
        attemptId?: string;
      }
    | undefined;
  const captured = await withStubbedFetch(
    () =>
      chatStreamWithUsage('{"findings":[]}', {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 70,
        completion_tokens: 50,
      }),
    async () => {
      await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'chat',
        thinking: false,
        onUsage: (event) => {
          usage = event;
        },
      });
    },
  );

  assert.deepEqual(captured[0]?.body.stream_options, { include_usage: true });
  assert.match(usage?.attemptId ?? '', /^[0-9a-f-]{36}$/i);
  const { attemptId: _attemptId, ...reportedUsage } = usage!;
  assert.deepEqual(reportedUsage, {
    inputTokens: 100,
    cachedInputTokens: 70,
    outputTokens: 50,
    tokenSource: 'provider',
    provider: 'api.deepseek.com',
    model: 'deepseek-v4-flash',
  });
});

test('Responses usage reports provider cache writes separately from cache reads', async () => {
  let usage:
    | {
        inputTokens: number;
        cachedInputTokens?: number;
        cacheWriteTokens?: number;
        outputTokens: number;
        tokenSource?: string;
      }
    | undefined;
  const encoder = new TextEncoder();
  await withStubbedFetch(
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'response.output_text.delta',
                delta: '{"findings":[]}',
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'response.completed',
                response: {
                  usage: {
                    input_tokens: 100,
                    input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
                    output_tokens: 20,
                  },
                },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      }),
    async () => {
      await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'gpt-5.6-luna',
        baseUrl: 'https://api.openai.example/v1',
        api: 'responses',
        thinking: false,
        onUsage: (event) => {
          usage = event;
        },
      });
    },
  );
  assert.deepEqual(usage, {
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteTokens: 10,
    outputTokens: 20,
    tokenSource: 'provider',
    provider: 'api.openai.example',
    model: 'gpt-5.6-luna',
    attemptId: usage?.attemptId,
  });
  assert.match(usage?.attemptId ?? '', /^[0-9a-f-]{36}$/i);
});

test('an explicit max reasoning effort is never downgraded on a retry-style call', async () => {
  const captured = await withStubbedFetch(
    () => chatStream('{"findings":[]}'),
    async () => {
      await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://example.test/v1',
        api: 'chat',
        reasoningEffort: 'max',
        maxTokens: 32_000,
        thinking: false,
      });
    },
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.reasoning_effort, 'max');
  assert.equal(captured[0].body.max_tokens, 32_000);
  assert.equal('max_completion_tokens' in captured[0].body, false);
});

test('official DeepSeek requests use its native thinking switch at max effort', async () => {
  const captured = await withStubbedFetch(
    () => chatStream('{"findings":[]}'),
    async () => {
      await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'chat',
        reasoningEffort: 'max',
        maxTokens: 28_000,
        json: true,
      });
    },
  );

  assert.deepEqual(captured[0]?.body.thinking, { type: 'enabled' });
  assert.equal('chat_template_kwargs' in captured[0].body, false);
  assert.equal('reasoning_split' in captured[0].body, false);
  assert.equal(captured[0].body.reasoning_effort, 'max');
  assert.equal(captured[0].body.max_tokens, 28_000);
  const messages = captured[0].body.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0]?.content ?? '', /finish private reasoning within 18,000 tokens/i);
  assert.match(messages[0]?.content ?? '', /reserve the remaining response budget/i);
});

test('a reasoning-only compatible response reports output exhaustion accurately', async () => {
  const encoder = new TextEncoder();
  await assert.rejects(
    () =>
      withStubbedFetch(
        () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
        async () => {
          await llmChat('sys', 'user', {
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            baseUrl: 'https://example.test/v1',
            api: 'chat',
            reasoningEffort: 'max',
            maxTokens: 36_000,
          });
        },
      ),
    /truncated \(finish_reason=length\)/,
  );
});

test('official DeepSeek resumes one truncated max-reasoning response through prefix completion', async () => {
  const encoder = new TextEncoder();
  let call = 0;
  let admissions = 0;
  let releases = 0;
  const events: LlmAttemptEvent[] = [];
  const usage: Array<{ attemptId?: string; outputTokens: number }> = [];
  const clock = new ManualClock();
  const admission: LlmProviderCoordinator = {
    async acquireProviderLease() {
      admissions++;
      return `lease-${admissions}`;
    },
    async releaseProviderLease() {
      releases++;
    },
    async getProviderCooldownMs() {
      return 0;
    },
    async setProviderCooldown() {},
  };
  const captured = await withStubbedFetch(
    () => {
      call++;
      const chunks =
        call === 1
          ? [
              { choices: [{ delta: { reasoning_content: 'completed analysis' } }] },
              { choices: [{ delta: {}, finish_reason: 'length' }] },
              {
                choices: [],
                usage: {
                  prompt_tokens: 100,
                  prompt_cache_hit_tokens: 0,
                  completion_tokens: 28_000,
                },
              },
            ]
          : [
              { choices: [{ delta: { content: '[],"summary":"complete"}' } }] },
              { choices: [{ delta: {}, finish_reason: 'stop' }] },
              {
                choices: [],
                usage: {
                  prompt_tokens: 28_100,
                  prompt_cache_hit_tokens: 28_000,
                  completion_tokens: 40,
                },
              },
            ];
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
    },
    async () => {
      const result = await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'chat',
        reasoningEffort: 'max',
        maxTokens: 28_000,
        hardLimitMs: 30_000,
        json: true,
        dependencies: { admission, clock },
        onAttempt: (event) => events.push(event),
        onUsage: (event) => usage.push(event),
      });
      assert.equal(result, '{"findings":[],"summary":"complete"}');
    },
  );

  assert.equal(captured.length, 2);
  assert.equal(captured[0]?.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(captured[1]?.url, 'https://api.deepseek.com/beta/chat/completions');
  assert.equal(captured[1]?.body.reasoning_effort, 'max');
  assert.equal(captured[1]?.body.max_tokens, 16_000);
  assert.equal(
    'response_format' in captured[1]!.body,
    false,
    'DeepSeek prefix completion rejects response_format',
  );
  assert.deepEqual(captured[1]?.body.thinking, { type: 'disabled' });
  const messages = captured[1]?.body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages.at(-1), {
    role: 'assistant',
    content: '{"findings":',
    reasoning_content: 'completed analysis',
    prefix: true,
  });
  const starts = events.filter((event) => event.phase === 'started');
  const finishes = events.filter((event) => event.phase === 'finished');
  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.parentAttemptId, starts[0]?.attemptId);
  assert.deepEqual(
    starts.map((event) => event.retryIndex),
    [0, 1],
  );
  assert.deepEqual(
    finishes.map((event) => event.outcome),
    ['failed', 'succeeded'],
  );
  assert.equal(new Set(usage.map((event) => event.attemptId)).size, 2);
  assert.equal(admissions, 2, 'each paid request gets a fresh distributed admission');
  assert.equal(releases, 2);
  assert.equal(
    clock.timers.filter((timer) => timer.ms === 30_000).length,
    2,
    'the continuation inherits a stricter request wall cap',
  );
  assert.deepEqual(
    starts.map((event) => event.role),
    ['primary', 'continuation'],
  );
});

test('official DeepSeek resumes a partially streamed response after a provider termination', async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  const events: LlmAttemptEvent[] = [];
  const captured = await withStubbedFetch(
    () => {
      calls++;
      let pull = 0;
      return new ReadableStream({
        pull(controller) {
          if (calls === 1) {
            if (pull++ === 0)
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'completed analysis' } }] })}\n\n`,
                ),
              );
            else controller.error(new TypeError('terminated'));
            return;
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: '{"summary":"complete","findings":[]}' } }] })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
    },
    async () => {
      const result = await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'chat',
        reasoningEffort: 'max',
        maxTokens: 28_000,
        json: true,
        onAttempt: (event) => events.push(event),
      });
      assert.equal(result, '{"summary":"complete","findings":[]}');
    },
  );

  assert.equal(calls, 2);
  assert.equal(captured[1]?.url, 'https://api.deepseek.com/beta/chat/completions');
  assert.equal('response_format' in captured[1]!.body, false);
  const continuationMessages = captured[1]?.body.messages as Array<{
    role: string;
    reasoning_content?: string;
    content: string;
    prefix?: boolean;
  }>;
  assert.deepEqual(continuationMessages.at(-1), {
    role: 'assistant',
    content: '{"findings":',
    reasoning_content: 'completed analysis',
    prefix: true,
  });
  assert.deepEqual(
    events.filter((event) => event.phase === 'started').map((event) => event.role),
    ['primary', 'continuation'],
  );
});

test('official DeepSeek never treats schema-ambiguous JSON as complete after output exhaustion', async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  await assert.rejects(
    () =>
      withStubbedFetch(
        () =>
          new ReadableStream({
            start(controller) {
              calls++;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' } }] })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
        async () => {
          await llmChat('sys', 'user', {
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            baseUrl: 'https://api.deepseek.com/v1',
            api: 'chat',
            reasoningEffort: 'max',
            maxTokens: 28_000,
            json: true,
          });
        },
      ),
    /remained truncated after 2 bounded prefix continuation/,
  );
  assert.equal(calls, 3, 'length remains fail-closed even when the partial JSON parses');
});

test('a failed DeepSeek continuation never replays the expensive root request', async (t) => {
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let admissions = 0;
  let releases = 0;
  const events: LlmAttemptEvent[] = [];
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 2) return new Response('rate limited', { status: 429 });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'analysis' } }] })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const admission: LlmProviderCoordinator = {
    async acquireProviderLease() {
      admissions++;
      return `lease-${admissions}`;
    },
    async releaseProviderLease() {
      releases++;
    },
    async getProviderCooldownMs() {
      return 0;
    },
    async setProviderCooldown() {},
  };

  await assert.rejects(
    llmChat('sys', 'user', {
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'chat',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      json: true,
      dependencies: { admission },
      onAttempt: (event) => events.push(event),
    }),
    /429|rate limit/i,
  );
  assert.equal(calls, 2);
  assert.equal(admissions, 2);
  assert.equal(releases, 2);
  assert.deepEqual(
    events.filter((event) => event.phase === 'started').map((event) => event.role),
    ['primary', 'continuation'],
  );
});

test('DeepSeek prefix recovery is bounded without replaying the review', async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  await assert.rejects(
    () =>
      withStubbedFetch(
        () => {
          calls++;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'analysis' } }] })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
        },
        async () => {
          await llmChat('sys', 'user', {
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            baseUrl: 'https://api.deepseek.com/v1',
            api: 'chat',
            reasoningEffort: 'max',
            maxTokens: 28_000,
            json: true,
          });
        },
      ),
    /remained truncated after 2 bounded prefix continuation/,
  );
  assert.equal(calls, 3);
});

test('MiniMax keeps thinking enabled without consuming its answer budget', () => {
  assert.equal(resolveAnthropicThinkingBudget('MiniMax-M3', 20_000, 20_000), 6_000);
  assert.equal(resolveAnthropicThinkingBudget('other-model', 32_000, 20_000), 20_000);
});

test('environment drift cannot disable default reasoning or MiniMax thinking', async (t) => {
  const previousThinking = process.env.ORVEX_LLM_THINKING;
  const previousMode = process.env.ORVEX_THINKING_MODE;
  process.env.ORVEX_LLM_THINKING = '0';
  process.env.ORVEX_THINKING_MODE = 'disabled';
  t.after(() => {
    if (previousThinking === undefined) delete process.env.ORVEX_LLM_THINKING;
    else process.env.ORVEX_LLM_THINKING = previousThinking;
    if (previousMode === undefined) delete process.env.ORVEX_THINKING_MODE;
    else process.env.ORVEX_THINKING_MODE = previousMode;
  });

  const responses = await withStubbedFetch(
    () => responsesStream('{"findings":[]}'),
    async () => {
      await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'gpt-5.6-luna',
        baseUrl: 'https://example.test/v1',
        api: 'responses',
        reasoningEffort: 'max',
      });
    },
  );
  assert.deepEqual(responses[0].body.reasoning, { effort: 'max' });

  const minimax = await withStubbedFetch(
    () => chatStream('{"findings":[]}'),
    async () => {
      await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'MiniMax-M3',
        baseUrl: 'https://example.test/v1',
        api: 'chat',
      });
    },
  );
  assert.deepEqual(minimax[0].body.chat_template_kwargs, { thinking_mode: 'enabled' });
});

test('rate-limit failure never contacts a configured substitute endpoint', async (t) => {
  const previous = {
    retries: process.env.ORVEX_RATELIMIT_MAX_RETRIES,
    url: process.env.ORVEX_FALLBACK_BASE_URL,
    key: process.env.ORVEX_FALLBACK_API_KEY,
    model: process.env.ORVEX_FALLBACK_MODEL,
  };
  process.env.ORVEX_RATELIMIT_MAX_RETRIES = '1';
  process.env.ORVEX_FALLBACK_BASE_URL = 'https://fallback.invalid/v1';
  process.env.ORVEX_FALLBACK_API_KEY = 'fallback-key';
  process.env.ORVEX_FALLBACK_MODEL = 'expensive-substitute';
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    return new Response('{"error":{"message":"rate limit"}}', { status: 429 });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      ORVEX_RATELIMIT_MAX_RETRIES: previous.retries,
      ORVEX_FALLBACK_BASE_URL: previous.url,
      ORVEX_FALLBACK_API_KEY: previous.key,
      ORVEX_FALLBACK_MODEL: previous.model,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  await assert.rejects(
    llmChat('sys', 'user', {
      apiKey: 'primary-key',
      model: 'primary-review-model',
      baseUrl: 'https://primary.example/v1',
      api: 'chat',
      reasoningEffort: 'max',
    }),
    /429|rate limit/i,
  );
  assert.deepEqual(urls, ['https://primary.example/v1/chat/completions']);
});

test('usage callbacks identify the actual provider and model', async () => {
  let usage: { provider?: string; model?: string; tokenSource?: string } | undefined;
  await withStubbedFetch(
    () => responsesStream('{"findings":[]}'),
    async () => {
      await llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: 'gpt-5.6-luna',
        baseUrl: 'https://api.example.test/v1',
        api: 'responses',
        thinking: false,
        onUsage: (event) => {
          usage = event;
        },
      });
    },
  );
  assert.equal(usage?.provider, 'api.example.test');
  assert.equal(usage?.model, 'gpt-5.6-luna');
  assert.equal(usage?.tokenSource, 'provider');
});

test('provider-specific LLM concurrency hands off slots without exceeding the configured limit', async (t) => {
  const previous = process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST;
  process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST = '1';
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximum = 0;
  globalThis.fetch = (async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return new Response(responsesStream('{"findings":[]}'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST;
    else process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST = previous;
  });

  await Promise.all([
    llmChat('sys', 'one', {
      apiKey: 'test-key',
      model: 'm',
      baseUrl: 'https://example.test/v1',
      api: 'responses',
      thinking: false,
    }),
    llmChat('sys', 'two', {
      apiKey: 'test-key',
      model: 'm',
      baseUrl: 'https://example.test/v1',
      api: 'responses',
      thinking: false,
    }),
  ]);
  assert.equal(maximum, 1);
});

test('production provider defaults expose one DeepSeek lane for each review slot', () => {
  assert.equal(providerConcurrency('luna', {}), 8);
  assert.equal(providerConcurrency('deepseek', {}), 8);
  assert.equal(providerConcurrency('minimax', {}), 8);
  assert.equal(providerConcurrency('luna', { ORVEX_PROVIDER_CONCURRENCY_LUNA: '3' }), 3);
});

test('DeepSeek max-reasoning gate admits eight calls and holds the ninth', async (t) => {
  const previous = process.env.ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK;
  process.env.ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK = '8';
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedEight!: () => void;
  const eightStarted = new Promise<void>((resolve) => {
    reachedEight = resolve;
  });
  globalThis.fetch = (async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    if (active === 8) reachedEight();
    await hold;
    active--;
    return new Response(chatStream('{"findings":[]}'), { status: 200 });
  }) as typeof globalThis.fetch;
  t.after(() => {
    release();
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK;
    else process.env.ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK = previous;
  });

  const target = {
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'chat' as const,
    reasoningEffort: 'max',
    maxTokens: 32_000,
  };
  const requests = Array.from({ length: 9 }, (_, index) =>
    llmChat('sys', `request-${index}`, target),
  );
  await eightStarted;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 8, 'the ninth call must remain queued behind the provider gate');
  release();
  await Promise.all(requests);
  assert.equal(maximum, 8);
});

test('caller cancellation aborts the active stream and never retries paid work', async (t) => {
  const previousRetries = process.env.ORVEX_RATELIMIT_MAX_RETRIES;
  process.env.ORVEX_RATELIMIT_MAX_RETRIES = '4';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = (async (_input, init) => {
    calls++;
    started();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousRetries === undefined) delete process.env.ORVEX_RATELIMIT_MAX_RETRIES;
    else process.env.ORVEX_RATELIMIT_MAX_RETRIES = previousRetries;
  });

  const controller = new AbortController();
  const pending = llmChat('sys', 'user', {
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://example.test/v1',
    api: 'chat',
    signal: controller.signal,
  });
  await didStart;
  controller.abort('pr_closed_mid_run');

  await assert.rejects(pending, (error) => error instanceof ReviewCancelledError);
  assert.equal(calls, 1);
});

test('a cancelled provider-slot waiter never reaches fetch', async (t) => {
  const previousConcurrency = process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST;
  process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST = '1';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let firstStarted!: () => void;
  const didStart = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  globalThis.fetch = (async (_input, init) => {
    calls++;
    firstStarted();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      init?.signal?.addEventListener('abort', abort, { once: true });
      if (init?.signal?.aborted) abort();
    });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousConcurrency === undefined)
      delete process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST;
    else process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST = previousConcurrency;
  });

  const firstController = new AbortController();
  const first = llmChat('sys', 'first', {
    apiKey: 'test-key',
    model: 'm',
    baseUrl: 'https://example.test/v1',
    api: 'responses',
    signal: firstController.signal,
  });
  await didStart;

  const secondController = new AbortController();
  const second = llmChat('sys', 'second', {
    apiKey: 'test-key',
    model: 'm',
    baseUrl: 'https://example.test/v1',
    api: 'responses',
    signal: secondController.signal,
  });
  secondController.abort();
  await assert.rejects(second, (error) => error instanceof ReviewCancelledError);
  assert.equal(calls, 1);

  firstController.abort();
  await assert.rejects(first, (error) => error instanceof ReviewCancelledError);
});

for (const api of ['responses', 'chat'] as const) {
  test(`${api} transport has an independent hard wall-clock abort`, async (t) => {
    const previous = {
      short: process.env.ORVEX_TEST_SHORT_TIMEOUTS,
      hard: process.env.ORVEX_LLM_MAX_TOTAL_MS,
      retries: process.env.ORVEX_RATELIMIT_MAX_RETRIES,
    };
    process.env.ORVEX_TEST_SHORT_TIMEOUTS = '1';
    process.env.ORVEX_LLM_MAX_TOTAL_MS = '40';
    process.env.ORVEX_RATELIMIT_MAX_RETRIES = '1';
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', abort, { once: true });
        if (init?.signal?.aborted) abort();
      });
    }) as typeof globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries({
        ORVEX_TEST_SHORT_TIMEOUTS: previous.short,
        ORVEX_LLM_MAX_TOTAL_MS: previous.hard,
        ORVEX_RATELIMIT_MAX_RETRIES: previous.retries,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const started = Date.now();
    await assert.rejects(
      llmChat('sys', 'user', {
        apiKey: 'test-key',
        model: `hard-${api}`,
        baseUrl: `https://hard-${api}.test/v1`,
        api,
      }),
      /wall-clock cap/,
    );
    assert.equal(calls, 1);
    assert.ok(
      Date.now() - started < 500,
      'hard timer settled without waiting for inactivity timeout',
    );
  });
}

test('a timed-out compatible stream records the partial provider work as estimated usage', async (t) => {
  const previous = {
    short: process.env.ORVEX_TEST_SHORT_TIMEOUTS,
    hard: process.env.ORVEX_LLM_MAX_TOTAL_MS,
    retries: process.env.ORVEX_RATELIMIT_MAX_RETRIES,
  };
  process.env.ORVEX_TEST_SHORT_TIMEOUTS = '1';
  process.env.ORVEX_LLM_MAX_TOTAL_MS = '40';
  process.env.ORVEX_RATELIMIT_MAX_RETRIES = '1';
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let usage:
    | {
        inputTokens: number;
        outputTokens: number;
        tokenSource?: string;
        attemptId?: string;
      }
    | undefined;
  globalThis.fetch = (async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'x'.repeat(400) } }] })}\n\n`,
            ),
          );
          const abort = () => controller.error(new DOMException('aborted', 'AbortError'));
          init?.signal?.addEventListener('abort', abort, { once: true });
          if (init?.signal?.aborted) abort();
        },
      }),
      { status: 200 },
    )) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      ORVEX_TEST_SHORT_TIMEOUTS: previous.short,
      ORVEX_LLM_MAX_TOTAL_MS: previous.hard,
      ORVEX_RATELIMIT_MAX_RETRIES: previous.retries,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await assert.rejects(
    llmChat('system', 'user', {
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://partial-timeout.test',
      api: 'chat',
      onUsage: (event) => {
        usage = event;
      },
    }),
    /wall-clock cap/,
  );
  assert.equal(usage?.tokenSource, 'estimate');
  assert.ok((usage?.inputTokens ?? 0) > 0);
  assert.ok((usage?.outputTokens ?? 0) > 0);
  assert.match(usage?.attemptId ?? '', /^[0-9a-f-]{36}$/i);
});

test('every actual provider request emits durable retry lineage and retries at most once', async (t) => {
  const previous = {
    retries: process.env.ORVEX_RATELIMIT_MAX_RETRIES,
    base: process.env.ORVEX_RATELIMIT_BASE_MS,
    wait: process.env.ORVEX_RATELIMIT_MAX_WAIT_MS,
    total: process.env.ORVEX_RATELIMIT_TOTAL_WAIT_MS,
  };
  process.env.ORVEX_RATELIMIT_MAX_RETRIES = '99';
  process.env.ORVEX_RATELIMIT_BASE_MS = '250';
  process.env.ORVEX_RATELIMIT_MAX_WAIT_MS = '1000';
  process.env.ORVEX_RATELIMIT_TOTAL_WAIT_MS = '1000';
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  Math.random = () => 0;
  let calls = 0;
  const events: LlmAttemptEvent[] = [];
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response('rate limited', { status: 429 });
    return new Response(chatStream('{"findings":[]}'), { status: 200 });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
    for (const [key, value] of Object.entries({
      ORVEX_RATELIMIT_MAX_RETRIES: previous.retries,
      ORVEX_RATELIMIT_BASE_MS: previous.base,
      ORVEX_RATELIMIT_MAX_WAIT_MS: previous.wait,
      ORVEX_RATELIMIT_TOTAL_WAIT_MS: previous.total,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await llmChat('sys', 'user', {
    apiKey: 'test-key',
    model: 'retry-lineage-model',
    baseUrl: 'https://retry-lineage.test/v1',
    api: 'chat',
    onAttempt: (event) => events.push(event),
  });
  assert.equal(calls, 2, 'env cannot raise the one-retry ceiling');
  const starts = events.filter((event) => event.phase === 'started');
  const finishes = events.filter((event) => event.phase === 'finished');
  assert.equal(starts.length, 2);
  assert.equal(finishes.length, 2);
  assert.equal(starts[1]!.parentAttemptId, starts[0]!.attemptId);
  assert.equal(finishes[0]!.outcome, 'rate_limited');
  assert.equal(finishes[1]!.outcome, 'succeeded');
});

test('an empty zero-usage provider response receives one bounded retry', async (t) => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  let calls = 0;
  const events: LlmAttemptEvent[] = [];
  t.after(() => {
    Math.random = originalRandom;
  });

  const output = await llmChat('sys', 'user', {
    apiKey: 'test-key',
    model: 'empty-response-model',
    baseUrl: 'https://empty-response.test/v1',
    api: 'responses',
    dependencies: {
      retryPolicy: { maxAttempts: 2, baseMs: 250, maxWaitMs: 1_000, totalWaitBudgetMs: 5_000 },
      http: {
        async fetch() {
          calls++;
          return new Response(
            calls === 1 ? emptyZeroUsageResponsesStream() : responsesStream('ok'),
            {
              status: 200,
            },
          );
        },
      },
    },
    onAttempt: (event) => events.push(event),
  });

  assert.equal(output, 'ok');
  assert.equal(calls, 2);
  assert.equal(events.filter((event) => event.phase === 'started').length, 2);
  assert.deepEqual(
    events.filter((event) => event.phase === 'finished').map((event) => event.outcome),
    ['failed', 'succeeded'],
  );
});

test('comma-separated API keys share one total provider-attempt ceiling', async () => {
  const calls: string[] = [];
  const events: LlmAttemptEvent[] = [];
  await assert.rejects(
    llmChat('sys', 'user', {
      apiKey: 'first-test-key, second-test-key, third-test-key',
      model: 'bounded-key-rotation-model',
      baseUrl: 'https://bounded-key-rotation.test/v1',
      api: 'chat',
      dependencies: {
        retryPolicy: { maxAttempts: 99, baseMs: 250, maxWaitMs: 1_000, totalWaitBudgetMs: 5_000 },
        http: {
          async fetch(_input, init) {
            calls.push(String(new Headers(init?.headers).get('Authorization')));
            return new Response('rate limited', { status: 429 });
          },
        },
      },
      onAttempt: (event) => events.push(event),
    }),
    /429|rate limit/i,
  );
  assert.equal(calls.length, 2, 'the hard ceiling covers all keys, not retry rounds per key');
  assert.equal(new Set(calls).size, 2, 'the bounded retry rotates to one alternate key');
  assert.equal(events.filter((event) => event.phase === 'started').length, 2);
  assert.equal(events.filter((event) => event.phase === 'finished').length, 2);
});

interface TestTimer {
  ms: number;
  active: boolean;
  callback: () => void;
}

class ManualClock implements Clock {
  readonly timers: TestTimer[] = [];

  now(): number {
    return 0;
  }

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer: TestTimer = { callback, ms, active: true };
    this.timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    (timer as unknown as TestTimer).active = false;
  }

  fireNext(): void {
    const timer = this.timers
      .filter((candidate) => candidate.active)
      .sort((a, b) => a.ms - b.ms)[0];
    assert.ok(timer, 'expected an armed timeout');
    timer.active = false;
    timer.callback();
  }

  get activeTimers(): number {
    return this.timers.filter((timer) => timer.active).length;
  }
}

class FakeAnthropicStream<T> {
  private readonly activityListeners = new Set<() => void>();
  private resolveMessage!: (value: T) => void;
  readonly final = new Promise<T>((resolve) => {
    this.resolveMessage = resolve;
  });
  aborts = 0;

  finalMessage(): Promise<T> {
    return this.final;
  }

  abort(): void {
    this.aborts++;
  }

  on(_event: 'streamEvent', listener: () => void): void {
    this.activityListeners.add(listener);
  }

  off(_event: 'streamEvent', listener: () => void): void {
    this.activityListeners.delete(listener);
  }

  emitActivity(): void {
    for (const listener of this.activityListeners) listener();
  }

  resolve(value: T): void {
    this.resolveMessage(value);
  }

  get listeners(): number {
    return this.activityListeners.size;
  }
}

test('Anthropic inactivity watchdog resets on stream activity and cleans up after a late close', async () => {
  const clock = new ManualClock();
  const stream = new FakeAnthropicStream({ ok: true });
  const pending = awaitAnthropicFinalMessage(stream, {
    apiKey: 'test-key',
    model: 'test-model',
    api: 'anthropic',
    dependencies: { clock },
  });
  assert.equal(stream.listeners, 1);
  assert.equal(clock.activeTimers, 2);

  stream.emitActivity();
  assert.equal(
    clock.activeTimers,
    2,
    'activity replaces rather than accumulates inactivity timers',
  );
  clock.fireNext();
  assert.equal(stream.aborts, 1, 'the re-armed inactivity timer aborts a silent stream');
  stream.resolve({ ok: true });

  await assert.rejects(pending, /anthropic stream stalled/);
  assert.equal(stream.listeners, 0, 'late completion cannot retain SDK listeners');
  assert.equal(clock.activeTimers, 0, 'late completion clears both watchdog timers');
});

test('Anthropic cancellation wins a timeout/close race and clears watchdog resources', async () => {
  const clock = new ManualClock();
  const stream = new FakeAnthropicStream({ ok: true });
  const controller = new AbortController();
  const pending = awaitAnthropicFinalMessage(stream, {
    apiKey: 'test-key',
    model: 'test-model',
    api: 'anthropic',
    signal: controller.signal,
    dependencies: { clock },
  });
  controller.abort('review-cancelled');
  stream.resolve({ ok: true });

  await assert.rejects(pending, ReviewCancelledError);
  assert.equal(stream.aborts, 1);
  assert.equal(stream.listeners, 0);
  assert.equal(clock.activeTimers, 0);
});

test('provider cooldowns delay only reviews that require that provider', async (t) => {
  const previousRetries = process.env.ORVEX_RATELIMIT_MAX_RETRIES;
  process.env.ORVEX_RATELIMIT_MAX_RETRIES = '1';
  const cooldowns = new Map<string, number>();
  const coordinator: LlmProviderCoordinator = {
    async acquireProviderLease() {
      return 'lease';
    },
    async releaseProviderLease() {},
    async getProviderCooldownMs(provider) {
      return Math.max(0, (cooldowns.get(provider) ?? 0) - Date.now());
    },
    async setProviderCooldown(provider, durationMs) {
      cooldowns.set(provider, Date.now() + durationMs);
    },
  };
  configureLlmProviderCoordinator(coordinator);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const events: LlmAttemptEvent[] = [];
  globalThis.fetch = (async () => {
    calls++;
    return new Response(chatStream('{"findings":[]}'), { status: 200 });
  }) as typeof globalThis.fetch;
  t.after(() => {
    configureLlmProviderCoordinator();
    globalThis.fetch = originalFetch;
    if (previousRetries === undefined) delete process.env.ORVEX_RATELIMIT_MAX_RETRIES;
    else process.env.ORVEX_RATELIMIT_MAX_RETRIES = previousRetries;
  });

  const target = {
    apiKey: 'test-key',
    model: 'independent-model',
    baseUrl: 'https://provider-a.test/v1',
    api: 'chat' as const,
    onAttempt: (event: LlmAttemptEvent) => events.push(event),
  };
  await setProviderCooldown('luna', 250);
  await waitForProviderAvailability(['provider-a-test']);
  await llmChat('sys', 'user', target);
  assert.equal(calls, 1, 'an independent provider remains available');

  await setProviderCooldown('provider-a-test', 250);
  const waitedFrom = Date.now();
  await llmChat('sys', 'user', target);
  assert.ok(Date.now() - waitedFrom >= 200, 'waits out the provider-specific cooldown');
  assert.equal(calls, 2, 'the call proceeds after the cooldown clears without weakening the review');
});

test('an active request reaching its hard cap does not cool the whole provider', () => {
  assert.equal(
    providerCooldownForFailure('LLM chat call exceeded 300000ms wall-clock cap'),
    undefined,
  );
  assert.equal(providerCooldownForFailure('LLM chat stream stalled'), 30_000);
  assert.equal(providerCooldownForFailure('LLM request failed (529): overloaded'), 2_000);
});

test('cancellation during a distributed lease wait is recorded as cancelled', async (t) => {
  const coordinator: LlmProviderCoordinator = {
    async acquireProviderLease(_provider, _limit, signal) {
      return new Promise<string>((_resolve, reject) => {
        const fail = () => reject(new Error('review cancelled while waiting for provider lease'));
        signal?.addEventListener('abort', fail, { once: true });
        if (signal?.aborted) fail();
      });
    },
    async releaseProviderLease() {},
    async getProviderCooldownMs() {
      return 0;
    },
    async setProviderCooldown() {},
  };
  configureLlmProviderCoordinator(coordinator);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(chatStream('{"findings":[]}'), { status: 200 });
  }) as typeof globalThis.fetch;
  t.after(() => {
    configureLlmProviderCoordinator();
    globalThis.fetch = originalFetch;
  });

  const controller = new AbortController();
  const events: LlmAttemptEvent[] = [];
  const pending = llmChat('sys', 'user', {
    apiKey: 'test-key',
    model: 'lease-cancel-model',
    baseUrl: 'https://lease-cancel.test/v1',
    api: 'chat',
    signal: controller.signal,
    onAttempt: (event) => events.push(event),
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(pending, ReviewCancelledError);
  assert.equal(calls, 0);
  const finished = events.find((event) => event.phase === 'finished');
  assert.equal(finished?.phase, 'finished');
  if (finished?.phase === 'finished') assert.equal(finished.outcome, 'cancelled');
});

test('a distributed lease waiter rechecks cooldown before starting paid work', async (t) => {
  let cooldownReads = 0;
  let releases = 0;
  const coordinator: LlmProviderCoordinator = {
    async acquireProviderLease() {
      return 'waiter-lease';
    },
    async releaseProviderLease() {
      releases++;
    },
    async getProviderCooldownMs() {
      cooldownReads++;
      return cooldownReads === 1 ? 0 : 250;
    },
    async setProviderCooldown() {},
  };
  configureLlmProviderCoordinator(coordinator);
  t.after(() => configureLlmProviderCoordinator());

  let paidCalls = 0;
  await assert.rejects(
    withProviderCallSlot('handoff-provider', async () => {
      paidCalls++;
    }),
    /cooldown active/i,
  );

  assert.equal(paidCalls, 0);
  assert.equal(releases, 1, 'the rejected waiter releases its distributed lease');
});

test('200 synthetic review arrivals obey worker and provider backpressure', async (t) => {
  const previous = {
    luna: process.env.ORVEX_PROVIDER_CONCURRENCY_LUNA,
    deepseek: process.env.ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK,
    minimax: process.env.ORVEX_PROVIDER_CONCURRENCY_MINIMAX,
  };
  process.env.ORVEX_PROVIDER_CONCURRENCY_LUNA = '1';
  process.env.ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK = '1';
  process.env.ORVEX_PROVIDER_CONCURRENCY_MINIMAX = '2';
  configureLlmProviderCoordinator();
  t.after(() => {
    for (const [key, value] of Object.entries({
      ORVEX_PROVIDER_CONCURRENCY_LUNA: previous.luna,
      ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK: previous.deepseek,
      ORVEX_PROVIDER_CONCURRENCY_MINIMAX: previous.minimax,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const active = new Map<string, number>();
  const peaks = new Map<string, number>();
  const providerCall = (provider: string) =>
    withProviderCallSlot(provider, async () => {
      const current = (active.get(provider) ?? 0) + 1;
      active.set(provider, current);
      peaks.set(provider, Math.max(peaks.get(provider) ?? 0, current));
      await new Promise((resolve) => setTimeout(resolve, 2));
      active.set(provider, Math.max(0, (active.get(provider) ?? 1) - 1));
    });

  await setProviderCooldown('luna', 250);
  let nextJob = 0;
  let activeReviews = 0;
  let peakReviews = 0;
  let firstLowCompletedAt = Number.POSITIVE_INFINITY;
  let firstLunaStartedAt = Number.POSITIVE_INFINITY;
  const jobs = Array.from({ length: 200 }, (_, index) => (index % 2 === 0 ? 'high' : 'low'));
  const worker = async () => {
    for (;;) {
      const index = nextJob++;
      if (index >= jobs.length) return;
      activeReviews++;
      peakReviews = Math.max(peakReviews, activeReviews);
      try {
        const providers =
          jobs[index] === 'high' ? ['luna', 'deepseek', 'minimax'] : ['deepseek', 'minimax'];
        await waitForProviderAvailability(providers);
        if (providers.includes('luna'))
          firstLunaStartedAt = Math.min(firstLunaStartedAt, Date.now());
        await Promise.all(providers.map(providerCall));
        if (jobs[index] === 'low') firstLowCompletedAt = Math.min(firstLowCompletedAt, Date.now());
      } finally {
        activeReviews--;
      }
    }
  };

  await Promise.all(Array.from({ length: 4 }, worker));

  assert.equal(peakReviews, 4);
  assert.equal(peaks.get('luna'), 1);
  assert.equal(peaks.get('deepseek'), 1);
  assert.equal(peaks.get('minimax'), 2);
  assert.ok(
    firstLowCompletedAt < firstLunaStartedAt,
    'Luna cooldown must not block lower-tier provider work',
  );
});

test('a review cancelled during provider admission starts no paid calls', async () => {
  const controller = new AbortController();
  await setProviderCooldown('queued-cancel-provider', 250);
  let calls = 0;
  const pending = waitForProviderAvailability(['queued-cancel-provider'], controller.signal).then(
    () => {
      calls++;
    },
  );
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(pending, ReviewCancelledError);
  assert.equal(calls, 0);
});

test('provider cooldown admission has an independent bounded wait', async () => {
  const coordinator: LlmProviderCoordinator = {
    async acquireProviderLease() {
      return 'unused';
    },
    async releaseProviderLease() {},
    async getProviderCooldownMs() {
      return 60_000;
    },
    async setProviderCooldown() {},
  };
  const started = Date.now();
  await assert.rejects(
    waitForProviderAvailability(['saturated-provider'], undefined, coordinator, 10),
    /admission timed out/i,
  );
  assert.ok(
    Date.now() - started < 250,
    'cooldown admission does not occupy a worker slot long-term',
  );
});
