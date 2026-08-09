import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureLlmProviderCoordinator,
  llmChat,
  ReviewCancelledError,
  setProviderCooldown,
  type LlmAttemptEvent,
  type LlmProviderCoordinator,
} from './llm-client.js';

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
        thinking: false,
      });
    },
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.reasoning_effort, 'max');
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
      model: 'deepseek-v4-flash',
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
    llmChat('sys', 'one', { apiKey: 'test-key', model: 'm', baseUrl: 'https://example.test/v1', api: 'responses', thinking: false }),
    llmChat('sys', 'two', { apiKey: 'test-key', model: 'm', baseUrl: 'https://example.test/v1', api: 'responses', thinking: false }),
  ]);
  assert.equal(maximum, 1);
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
    if (previousConcurrency === undefined) delete process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST;
    else process.env.ORVEX_PROVIDER_CONCURRENCY_EXAMPLE_TEST = previousConcurrency;
  });

  const firstController = new AbortController();
  const first = llmChat('sys', 'first', {
    apiKey: 'test-key', model: 'm', baseUrl: 'https://example.test/v1', api: 'responses',
    signal: firstController.signal,
  });
  await didStart;

  const secondController = new AbortController();
  const second = llmChat('sys', 'second', {
    apiKey: 'test-key', model: 'm', baseUrl: 'https://example.test/v1', api: 'responses',
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
    assert.ok(Date.now() - started < 500, 'hard timer settled without waiting for inactivity timeout');
  });
}

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

test('a distributed review-stack circuit blocks every provider before fetch', async (t) => {
  const previousRetries = process.env.ORVEX_RATELIMIT_MAX_RETRIES;
  process.env.ORVEX_RATELIMIT_MAX_RETRIES = '1';
  const cooldowns = new Map<string, number>();
  const coordinator: LlmProviderCoordinator = {
    async acquireProviderLease() { return 'lease'; },
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

  await setProviderCooldown('review-stack', 250);
  await assert.rejects(
    llmChat('sys', 'user', {
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'chat',
    }),
    /review-stack|cooldown active|rate-limited/i,
  );
  assert.equal(calls, 0);
});
