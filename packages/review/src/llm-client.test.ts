import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmChat } from './llm-client.js';

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
    return new Response(stream(url), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

test('global LLM concurrency hands off slots without exceeding the configured limit', async (t) => {
  const previous = process.env.ORVEX_LLM_GLOBAL_CONCURRENCY;
  process.env.ORVEX_LLM_GLOBAL_CONCURRENCY = '1';
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
    if (previous === undefined) delete process.env.ORVEX_LLM_GLOBAL_CONCURRENCY;
    else process.env.ORVEX_LLM_GLOBAL_CONCURRENCY = previous;
  });

  await Promise.all([
    llmChat('sys', 'one', { apiKey: 'test-key', model: 'm', baseUrl: 'https://example.test/v1', api: 'responses', thinking: false }),
    llmChat('sys', 'two', { apiKey: 'test-key', model: 'm', baseUrl: 'https://example.test/v1', api: 'responses', thinking: false }),
  ]);
  assert.equal(maximum, 1);
});
