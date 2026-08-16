import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnthropicRunner,
  assertAttemptLifecycle,
  CodexCliRunner,
  CompatibleChatRunner,
  ResponsesRunner,
  type CodexCliRunRequest,
  type LlmClientOptions,
  type ModelAttemptEvent,
  type ModelRunner,
  type ProviderDependencies,
  type TextModelRunRequest,
} from '../index.js';

function observer(events: ModelAttemptEvent[]): ProviderDependencies {
  return { attemptObserver: { record: (event) => events.push(event) } };
}

function textExecutor(expectedApi: LlmClientOptions['api']) {
  return async (_system: string, _user: string, options: LlmClientOptions): Promise<string> => {
    assert.equal(options.api, expectedApi);
    const attemptId = `${expectedApi}-attempt`;
    options.dependencies?.attemptObserver?.record({
      phase: 'started',
      attemptId,
      retryIndex: 0,
      keyIndex: 0,
      provider: 'fake',
      model: options.model,
      transport: expectedApi!,
      startedAt: new Date(0).toISOString(),
    });
    options.dependencies?.attemptObserver?.record({
      phase: 'finished',
      attemptId,
      outcome: 'succeeded',
      durationMs: 1,
      completedAt: new Date(1).toISOString(),
    });
    return 'ok';
  };
}

function textRequest(
  transport: 'responses' | 'compatible-chat' | 'anthropic',
): TextModelRunRequest {
  return {
    system: 'system',
    user: 'user',
    target: {
      transport,
      apiKey: 'test-key',
      model: `${transport}-model`,
      baseUrl: 'https://example.test/v1',
    },
  };
}

function responseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`),
      );
      controller.close();
    },
  });
}

test('shared adapter contract: every explicit transport emits one terminal event per start', async () => {
  const textRunners: Array<{
    runner: ModelRunner<TextModelRunRequest>;
    request: TextModelRunRequest;
  }> = [];

  for (const [transport, Runner, api] of [
    ['responses', ResponsesRunner, 'responses'],
    ['compatible-chat', CompatibleChatRunner, 'chat'],
    ['anthropic', AnthropicRunner, 'anthropic'],
  ] as const) {
    const events: ModelAttemptEvent[] = [];
    const runner = new Runner(observer(events), textExecutor(api));
    textRunners.push({ runner, request: textRequest(transport) });
    assert.equal(await assertAttemptLifecycle(runner, textRequest(transport), events), 'ok');
  }

  assert.equal(textRunners.length, 3);

  const codexEvents: ModelAttemptEvent[] = [];
  const codexRunner = new CodexCliRunner(observer(codexEvents), async (_files, options) => {
    const attemptId = 'codex-attempt';
    options.dependencies?.attemptObserver?.record({
      phase: 'started',
      attemptId,
      retryIndex: 0,
      keyIndex: 0,
      provider: 'fake-codex',
      model: options.model ?? '',
      transport: 'codex-cli',
      startedAt: new Date(0).toISOString(),
    });
    options.dependencies?.attemptObserver?.record({
      phase: 'finished',
      attemptId,
      outcome: 'succeeded',
      durationMs: 1,
      completedAt: new Date(1).toISOString(),
    });
    return { response: { findings: [], summary: 'ok' }, threadId: 'fake-thread' };
  });
  const codexRequest: CodexCliRunRequest = {
    files: [],
    target: { transport: 'codex-cli', apiKey: '', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
  };
  const codexResult = await assertAttemptLifecycle(codexRunner, codexRequest, codexEvents);
  assert.equal(codexResult.threadId, 'fake-thread');
});

test('adapters reject a target for a different transport before it can run', async () => {
  const runner = new ResponsesRunner({}, textExecutor('responses'));
  assert.throws(() => runner.run(textRequest('compatible-chat')), /cannot run on responses/);
});

test('ResponsesRunner passes injected HTTP, clock, retry policy, and observer to the hardened client', async () => {
  const events: ModelAttemptEvent[] = [];
  let fetchCalls = 0;
  let timerCalls = 0;
  const runner = new ResponsesRunner({
    ...observer(events),
    retryPolicy: { maxAttempts: 1, maxWaitMs: 1_000, baseMs: 250, totalWaitBudgetMs: 5_000 },
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, ms) => {
        timerCalls++;
        return setTimeout(callback, ms);
      },
      clearTimeout: (timer) => clearTimeout(timer),
    },
    http: {
      async fetch(input) {
        fetchCalls++;
        assert.match(String(input), /\/responses$/);
        return new Response(responseStream('adapter-result'), { status: 200 });
      },
    },
  });

  assert.equal(
    await assertAttemptLifecycle(runner, textRequest('responses'), events),
    'adapter-result',
  );
  assert.equal(fetchCalls, 1);
  assert.ok(timerCalls >= 2, 'the injected clock owns both hard and inactivity timers');
});

test('text runners forward jsonContractPrefix to llmChat', async () => {
  let seen: string | undefined;
  const runner = new CompatibleChatRunner({}, async (_system, _user, options) => {
    seen = options.jsonContractPrefix;
    return 'ok';
  });
  assert.equal(
    await runner.run({
      ...textRequest('compatible-chat'),
      jsonContractPrefix: '{"verdicts":',
    }),
    'ok',
  );
  assert.equal(seen, '{"verdicts":');
});
