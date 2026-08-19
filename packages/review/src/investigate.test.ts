import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSafeGlob,
  isSafeGrepPattern,
  resolveUnderRoot,
  runInvestigateReview,
  runInvestigateTool,
  extractDeletedSymbols,
  investigateThinkingEnabled,
  classifyInvestigateResponse,
} from './investigate.js';

function compatibleChatStream(content: string, finishReason = 'stop'): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function responsesApiStream(content: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_test', status: 'completed' },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function incompleteResponsesApiStream(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'response.incomplete',
              response: {
                id: 'resp_incomplete',
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                usage: { input_tokens: 10, output_tokens: 10 },
              },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

test('resolveUnderRoot confines paths under checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.writeFileSync(path.join(root, 'ok.ts'), ' console.log(1)\n');
    fs.mkdirSync(path.join(root, 'src'));
    assert.ok(resolveUnderRoot(root, 'ok.ts')?.endsWith('ok.ts'));
    assert.ok(resolveUnderRoot(root, 'src'));
    assert.equal(resolveUnderRoot(root, '../outside'), null);
    assert.equal(resolveUnderRoot(root, '/etc/passwd'), null);
    assert.equal(resolveUnderRoot(root, 'src/../../outside'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveUnderRoot refuses symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-out-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'link'));
    assert.equal(resolveUnderRoot(root, 'link/secret.txt'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('grep pattern / glob safety', () => {
  assert.equal(isSafeGrepPattern('fooBar'), true);
  assert.equal(isSafeGrepPattern('--help'), false);
  assert.equal(isSafeGrepPattern(''), false);
  assert.equal(isSafeGlob('*.ts'), true);
  assert.equal(isSafeGlob('--glob'), false);
});

test('runInvestigateTool list_dir + read_file stay sandboxed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.writeFileSync(path.join(root, 'pkg/a.ts'), 'export const x = 1;\n');
    const listing = await runInvestigateTool(root, { name: 'list_dir', path: 'pkg' }, 8_000);
    assert.match(listing, /a\.ts/);
    const body = await runInvestigateTool(
      root,
      { name: 'read_file', path: 'pkg/a.ts', offset: 0, limit: 5 },
      8_000,
    );
    assert.match(body, /export const x/);
    const escaped = await runInvestigateTool(
      root,
      { name: 'read_file', path: '../etc/passwd' },
      8_000,
    );
    assert.match(escaped, /ERROR/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file redacts secrets even with line-number prefixes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.writeFileSync(path.join(root, 'cfg.yml'), 'secret_key_base: supersecretvalue1234567890\n');
    const body = await runInvestigateTool(root, { name: 'read_file', path: 'cfg.yml' }, 8_000);
    assert.doesNotMatch(body, /supersecretvalue1234567890/);
    assert.match(body, /1\|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('caller and test lookup tools are noninteractive, checkout-confined, and useful', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(
      path.join(root, 'src', 'widget.ts'),
      'export function renderWidget() { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(root, 'src', 'consumer.ts'),
      "import { renderWidget } from './widget';\nrenderWidget();\n",
    );
    fs.writeFileSync(
      path.join(root, 'test', 'widget.test.ts'),
      "import { renderWidget } from '../src/widget';\nrenderWidget();\n",
    );

    const callers = await runInvestigateTool(
      root,
      { name: 'find_callers', symbol: 'renderWidget', path: 'src' },
      8_000,
    );
    assert.match(callers, /consumer\.ts/);
    const tests = await runInvestigateTool(
      root,
      { name: 'find_tests', path: 'src/widget.ts' },
      8_000,
    );
    assert.match(tests, /widget\.test\.ts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grep redacts matching secrets and sensitive paths are refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.writeFileSync(
      path.join(root, 'config.yml'),
      'secret_key_base: supersecretvalue1234567890\n',
    );
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=hiddenvalue1234567890\n');
    const grep = await runInvestigateTool(
      root,
      { name: 'grep', pattern: 'secret_key_base' },
      8_000,
    );
    assert.doesNotMatch(grep, /supersecretvalue1234567890/);
    assert.match(grep, /REDACTED/);
    const env = await runInvestigateTool(root, { name: 'read_file', path: '.env' }, 8_000);
    assert.match(env, /sensitive file access is not available/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extractDeletedSymbols pulls renamed/removed functions from diffs', () => {
  const symbols = extractDeletedSymbols([
    {
      filename: 'a.ts',
      status: 'modified',
      patch: [
        '@@ -1,5 +1,5 @@',
        '-export async function releaseCoupon(id) {',
        '+export async function releaseCouponV2(id) {',
        '-const checkOwnership = (row) => {',
        '+const checkOwnership = (row, tenantId) => {',
      ].join('\n'),
    },
  ]);
  assert.ok(symbols.includes('releaseCoupon'));
  assert.ok(symbols.includes('checkOwnership'));
});

test('extractDeletedSymbols includes fully deleted files', () => {
  const symbols = extractDeletedSymbols([
    {
      filename: 'gone.ts',
      status: 'removed',
      patch: [
        '@@ -1,3 +0,0 @@',
        '-export function guardTenant(row) {',
        '-  return row.tenantId;',
        '-}',
      ].join('\n'),
    },
  ]);
  assert.ok(symbols.includes('guardTenant'));
});

test('investigate thinking stays off until the findings turn', () => {
  assert.equal(investigateThinkingEnabled(0, 6), false);
  assert.equal(investigateThinkingEnabled(4, 6), false);
  assert.equal(investigateThinkingEnabled(5, 6), true);
  assert.equal(investigateThinkingEnabled(0, 1), true);
});

test('investigate accepts an explicit bare empty-findings final as complete', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-final-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return compatibleChatStream('{"findings":[],"summary":"No actionable issues found."}');
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      maxSteps: 1,
    },
  );

  assert.equal(calls, 1, 'valid empty findings must not trigger a paid repair');
  assert.deepEqual(result, {
    findings: [],
    summary: 'No actionable issues found.',
  });
});

test('Flash investigate uses step and final JSON schemas on the Responses API', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-responses-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const currentValue = 1;\n');
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), body });
    return requests.length === 1
      ? responsesApiStream(
          '{"step":{"action":"tool","tool":{"name":"read_file","path":"a.ts","offset":null,"limit":null},"reason":"inspect source"}}',
        )
      : responsesApiStream(
          '{"action":"done","findings":[],"summary":"No actionable issues found."}',
        );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.test',
      api: 'responses',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      maxSteps: 2,
    },
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.url),
    ['https://api.deepseek.test/responses', 'https://api.deepseek.test/responses'],
  );
  const formats = requests.map(
    (request) => (request.body.text as { format?: Record<string, unknown> } | undefined)?.format,
  );
  assert.equal(formats[0]?.type, 'json_schema');
  assert.equal(formats[0]?.name, 'orvex_investigate_turn');
  assert.equal(formats[1]?.type, 'json_schema');
  assert.equal(formats[1]?.name, 'orvex_investigate_final');
  const stepSchema = formats[0]?.schema as
    | { type?: string; required?: string[]; anyOf?: unknown[] }
    | undefined;
  assert.ok(Array.isArray(stepSchema?.anyOf));
  assert.ok(
    (stepSchema?.anyOf ?? []).some(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        Array.isArray((entry as { required?: string[] }).required) &&
        (entry as { required?: string[] }).required?.includes('step'),
    ),
  );
  assert.deepEqual(requests[0]?.body.reasoning, { effort: 'none' });
  assert.deepEqual(requests[1]?.body.reasoning, { effort: 'max' });
  assert.deepEqual((formats[1]?.schema as { required?: string[] } | undefined)?.required, [
    'action',
    'findings',
    'summary',
  ]);
  assert.deepEqual(result, { findings: [], summary: 'No actionable issues found.' });
});

test('Flash investigate continues one truncated Responses final without replaying reasoning', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-responses-repair-'));
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return requests.length === 1
      ? incompleteResponsesApiStream()
      : responsesApiStream('{"action":"done","findings":[],"summary":"Recovered."}');
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.test',
      api: 'responses',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      maxSteps: 1,
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.max_output_tokens, 24_000);
  assert.deepEqual(requests[1]?.reasoning, { effort: 'none' });
  assert.ok(Array.isArray(requests[1]?.input));
  const repairedText = requests[1]?.text as { format?: { name?: string } } | undefined;
  assert.equal(repairedText?.format?.name, 'orvex_investigate_final');
  assert.deepEqual(result, { findings: [], summary: 'Recovered.' });
});

test('investigate repairs one malformed final without replaying tool hops', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-repair-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const currentValue = 1;\n');
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const content =
      calls === 1
        ? '{"action":"tool","tool":{"name":"read_file","path":"a.ts"},"reason":"inspect changed source"}'
        : calls === 2
          ? '{"action":"done","findings":[{"file":"a.ts","severity":"P2"}],"summary":"done"}'
          : '{"action":"done","findings":[],"summary":"Format repaired."}';
    return compatibleChatStream(content);
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      maxSteps: 2,
    },
  );

  assert.equal(calls, 3, 'one tool hop, one final, and one bounded repair are paid');
  assert.match(JSON.stringify(requests[1]), /currentValue/);
  assert.equal(requests[2]?.max_tokens, 28_000);
  assert.deepEqual(requests[2]?.chat_template_kwargs, { thinking_mode: 'disabled' });
  assert.deepEqual(result, { findings: [], summary: 'Format repaired.' });
});

test('investigate never treats summary-only JSON as a completed empty review', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-summary-only-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return compatibleChatStream('{"summary":"not a completed review contract"}');
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      maxSteps: 1,
    },
  );

  assert.equal(
    calls,
    3,
    'primary mismatch plus two bounded fresh repairs, no prefix continuations',
  );
  assert.deepEqual(result.findings, []);
  assert.match(result.summary ?? '', /could not be completed/i);
});

test('classifyInvestigateResponse accepts immediate finals before tool steps', () => {
  const emptyFinal = classifyInvestigateResponse(
    '{"action":"final","findings":[],"summary":"No actionable issues."}',
  );
  assert.equal(emptyFinal.type, 'final');
  if (emptyFinal.type === 'final') {
    assert.deepEqual(emptyFinal.value.findings, []);
    assert.equal(emptyFinal.value.summary, 'No actionable issues.');
  }
  const tool = classifyInvestigateResponse(
    '{"action":"tool","tool":{"name":"read_file","path":"a.ts"},"reason":"look"}',
  );
  assert.equal(tool.type, 'step');
  const wrapped = classifyInvestigateResponse(
    '{"step":{"action":"done","findings":[],"summary":"ok"}}',
  );
  assert.equal(wrapped.type, 'final');
  const incompleteFindings = classifyInvestigateResponse(
    '{"action":"done","findings":[{"file":"a.ts","severity":"P2"}],"summary":"done"}',
  );
  assert.equal(incompleteFindings.type, 'invalid');
  if (incompleteFindings.type === 'invalid') {
    assert.equal(incompleteFindings.shape, 'schema_mismatch');
  }
});

test('#318 immediate Flash final with zero findings completes without tools or continuations', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-318-'));
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return responsesApiStream(
      '{"action":"final","findings":[],"summary":"No actionable issues found."}',
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.test',
      api: 'responses',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      maxSteps: 4,
    },
  );

  assert.equal(bodies.length, 1);
  assert.equal(JSON.stringify(bodies).includes('{"step":{"action":'), false);
  assert.deepEqual(result, {
    findings: [],
    summary: 'No actionable issues found.',
  });
});

test('immediate investigate final with findings does not call tools', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-final-findings-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return compatibleChatStream(
      JSON.stringify({
        action: 'final',
        findings: [
          {
            file: 'a.ts',
            severity: 'P2',
            category: 'correctness',
            message: 'newValue is unused',
            confidence: 0.8,
          },
        ],
        summary: 'Found an issue.',
      }),
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      maxSteps: 4,
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.file, 'a.ts');
  assert.equal(result.summary, 'Found an issue.');
});

test('malformed investigate JSON uses a fresh repair without a guessed step prefix', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-malformed-'));
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    bodies.push(String(init?.body));
    return calls === 1
      ? compatibleChatStream('this is not json at all')
      : compatibleChatStream('{"action":"done","findings":[],"summary":"Repaired."}');
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      maxSteps: 3,
    },
  );

  assert.equal(calls, 2);
  assert.equal(
    bodies.some((body) => body.includes('{"step":{"action":')),
    false,
  );
  assert.match(bodies[1] ?? '', /PREVIOUS RESPONSE/);
  assert.match(bodies[1] ?? '', /request another tool/);
  assert.doesNotMatch(bodies[1] ?? '', /Do not call another tool|No more tools/);
  assert.deepEqual(result, { findings: [], summary: 'Repaired.' });
});

test('truncated investigate JSON continues from the received slice without a guessed step prefix', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-truncated-'));
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  let calls = 0;
  const truncated = '{"action":"final","findings":';
  globalThis.fetch = (async (_input, init) => {
    calls++;
    bodies.push(String(init?.body));
    return calls === 1
      ? compatibleChatStream(truncated, 'length')
      : compatibleChatStream(
          '{"action":"final","findings":[],"summary":"Finished truncated JSON."}',
        );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      maxSteps: 3,
    },
  );

  assert.equal(calls, 2);
  assert.equal(
    bodies.some((body) => body.includes('{"step":{"action":')),
    false,
  );
  const continuation = JSON.parse(bodies[1] ?? '{}') as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  const assistant = continuation.messages?.find((message) => message.role === 'assistant');
  assert.equal(assistant?.content, truncated);
  assert.match(bodies[1] ?? '', /Complete the JSON object now/);
  assert.doesNotMatch(bodies[1] ?? '', /FORMAT REPAIR/);
  assert.deepEqual(result, { findings: [], summary: 'Finished truncated JSON.' });
});

function captureInvestigateLogs(): { logs: Array<Record<string, unknown>>; restore: () => void } {
  const logs: Array<Record<string, unknown>> = [];
  const originalLog = console.log;
  console.log = ((message?: unknown, ...rest: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('[investigate] ')) {
      try {
        logs.push(JSON.parse(message.slice('[investigate] '.length)) as Record<string, unknown>);
      } catch {
        // Keep test spies from crashing on unrelated log lines.
      }
    }
    originalLog(message as never, ...rest);
  }) as typeof console.log;
  return {
    logs,
    restore: () => {
      console.log = originalLog;
    },
  };
}

function requestUserText(body: Record<string, unknown>): string {
  if (typeof body.input === 'string') return body.input;
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined;
  const user = messages?.find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : JSON.stringify(body);
}

function jsonSchemaName(body: Record<string, unknown>): string | undefined {
  return (body.text as { format?: { name?: string } } | undefined)?.format?.name;
}

test('#315 tool then schema-mismatch then repair second tool then final completes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-315-'));
  fs.mkdirSync(path.join(root, 'auth'));
  fs.writeFileSync(
    path.join(root, 'auth/middleware.ts'),
    'export function authorize() { return true; }\n',
  );
  const originalFetch = globalThis.fetch;
  const { logs, restore } = captureInvestigateLogs();
  const requests: Array<Record<string, unknown>> = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (calls === 1) {
      return responsesApiStream(
        '{"action":"tool","tool":{"name":"grep","pattern":"authorize","path":"auth"},"reason":"find authorize"}',
      );
    }
    if (calls === 2) {
      return responsesApiStream(
        '{"action":"done","findings":[{"file":"auth/middleware.ts","severity":"P2"}],"summary":"schema mismatch"}',
      );
    }
    if (calls === 3) {
      return responsesApiStream(
        '{"action":"tool","tool":{"name":"read_file","path":"auth/middleware.ts"},"reason":"read authorize implementation"}',
      );
    }
    return responsesApiStream('{"action":"final","findings":[],"summary":"No actionable issues."}');
  }) as typeof globalThis.fetch;
  t.after(() => {
    restore();
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'auth/middleware.ts',
        status: 'modified',
        patch:
          '@@ -1 +1 @@\n-export function authorize() { return false; }\n+export function authorize() { return true; }',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.test',
      api: 'responses',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      maxSteps: 5,
    },
  );

  assert.equal(calls, 4, 'tool, malformed, repaired tool, then final');
  assert.equal(jsonSchemaName(requests[0] ?? {}), 'orvex_investigate_turn');
  assert.equal(jsonSchemaName(requests[2] ?? {}), 'orvex_investigate_turn');
  assert.equal(jsonSchemaName(requests[3] ?? {}), 'orvex_investigate_turn');
  const repairUser = requestUserText(requests[2] ?? {});
  assert.match(repairUser, /FORMAT REPAIR/);
  assert.match(repairUser, /request another tool/);
  assert.match(repairUser, /CURRENT investigation state/);
  assert.doesNotMatch(repairUser, /Do not call another tool|No more tools|FINAL TURN/);
  assert.match(repairUser, /authorize/);
  const afterSecondTool = requestUserText(requests[3] ?? {});
  assert.match(afterSecondTool, /### Tool grep/);
  assert.match(afterSecondTool, /### Tool read_file/);
  assert.match(afterSecondTool, /export function authorize/);
  assert.equal(
    afterSecondTool.split('### Tool grep').length - 1,
    1,
    'already-executed grep must not rerun during repair',
  );
  const repairToolLog = logs.find(
    (entry) => entry.kind === 'recovery_tool' && entry.source === 'recovery',
  );
  assert.equal(repairToolLog?.stage, 'investigate');
  assert.equal(repairToolLog?.responseShape, 'tool');
  assert.equal(repairToolLog?.accepted, true);
  assert.equal(repairToolLog?.reenteredAgentLoop, true);
  assert.deepEqual(result, { findings: [], summary: 'No actionable issues.' });
});

test('tool then malformed then repair final completes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-315-final-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const currentValue = 1;\n');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return compatibleChatStream(
        '{"action":"tool","tool":{"name":"read_file","path":"a.ts"},"reason":"inspect"}',
      );
    }
    if (calls === 2) return compatibleChatStream('this is not json at all');
    return compatibleChatStream(
      '{"action":"final","findings":[],"summary":"Repaired after tool."}',
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      maxSteps: 5,
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(result, { findings: [], summary: 'Repaired after tool.' });
});

test('tool then malformed then repair tool then another tool then final completes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-315-loop-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const currentValue = 1;\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const nextValue = 2;\n');
  fs.writeFileSync(path.join(root, 'c.ts'), 'export const laterValue = 3;\n');
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (calls === 1) {
      return compatibleChatStream(
        '{"action":"tool","tool":{"name":"read_file","path":"a.ts"},"reason":"first"}',
      );
    }
    if (calls === 2) {
      return compatibleChatStream(
        '{"action":"done","findings":[{"file":"a.ts","severity":"P2"}],"summary":"schema mismatch"}',
      );
    }
    if (calls === 3) {
      return compatibleChatStream(
        '{"action":"tool","tool":{"name":"read_file","path":"b.ts"},"reason":"repaired"}',
      );
    }
    if (calls === 4) {
      return compatibleChatStream(
        '{"action":"tool","tool":{"name":"read_file","path":"c.ts"},"reason":"continue"}',
      );
    }
    return compatibleChatStream(
      '{"action":"done","findings":[],"summary":"Re-entered agent loop."}',
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      maxSteps: 6,
    },
  );

  assert.equal(calls, 5, 'tool, malformed, repair tool, another tool, final');
  const repairUser = requestUserText(requests[2] ?? {});
  assert.match(repairUser, /FORMAT REPAIR/);
  assert.match(repairUser, /request another tool/);
  const continued = requestUserText(requests[4] ?? {});
  assert.match(continued, /currentValue/);
  assert.match(continued, /nextValue/);
  assert.match(continued, /laterValue/);
  assert.deepEqual(result, { findings: [], summary: 'Re-entered agent loop.' });
});

test('tool then malformed then repair malformed is bounded and fail-closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-315-bound-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const currentValue = 1;\n');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return compatibleChatStream(
        '{"action":"tool","tool":{"name":"read_file","path":"a.ts"},"reason":"inspect"}',
      );
    }
    return compatibleChatStream('still not parseable json');
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      maxSteps: 8,
    },
  );

  assert.equal(calls, 4, 'one tool hop plus two bounded repairs, no infinite loop');
  assert.deepEqual(result.findings, []);
  assert.match(result.summary ?? '', /could not be completed/i);
});

test('repair may return a valid empty final after a prior tool', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-315-empty-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const currentValue = 1;\n');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return compatibleChatStream(
        '{"action":"tool","tool":{"name":"read_file","path":"a.ts"},"reason":"inspect"}',
      );
    }
    if (calls === 2) return compatibleChatStream('{"unexpected":true}');
    return compatibleChatStream(
      '{"action":"final","findings":[],"summary":"No actionable issues."}',
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://compatible.test/v1',
      api: 'chat',
      maxSteps: 5,
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(result, {
    findings: [],
    summary: 'No actionable issues.',
  });
});

test('#303 Flash investigate: two completed non-JSON replies then repair #2 FINAL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-303-final-'));
  const originalFetch = globalThis.fetch;
  const { logs, restore } = captureInvestigateLogs();
  const requests: Array<Record<string, unknown>> = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (calls === 1) {
      return responsesApiStream('Investigation complete. No issues found in this change.');
    }
    if (calls === 2) {
      return responsesApiStream('Still cannot emit the required JSON contract.');
    }
    return responsesApiStream(
      '{"action":"final","findings":[],"summary":"Repaired on second fresh generation."}',
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    restore();
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.test',
      api: 'responses',
      reasoningEffort: 'max',
      maxTokens: 28_000,
      maxSteps: 4,
    },
  );

  assert.equal(calls, 3, 'normal miss plus two fresh semantic repairs');
  assert.deepEqual(
    requests.map((request) => jsonSchemaName(request)),
    ['orvex_investigate_turn', 'orvex_investigate_turn', 'orvex_investigate_turn'],
  );
  assert.deepEqual(
    requests.map((request) => request.max_output_tokens),
    [28_000, 28_000, 28_000],
  );
  assert.equal(
    requests.every((request) => !('temperature' in request)),
    true,
  );
  assert.match(requestUserText(requests[1] ?? {}), /FORMAT REPAIR/);
  assert.match(requestUserText(requests[1] ?? {}), /request another tool/);
  assert.match(requestUserText(requests[2] ?? {}), /FORMAT REPAIR #2/);
  assert.match(requestUserText(requests[2] ?? {}), /request another tool/);
  assert.equal(typeof requests[1]?.input, 'string');
  assert.equal(typeof requests[2]?.input, 'string');
  assert.doesNotMatch(requestUserText(requests[1] ?? {}), /Complete the JSON object now/);
  assert.doesNotMatch(requestUserText(requests[2] ?? {}), /Complete the JSON object now/);
  const contracts = logs.filter((entry) => entry.stage === 'request_contract');
  assert.deepEqual(
    contracts.map((entry) => ({
      sourceLabel: entry.sourceLabel,
      schemaName: entry.schemaName,
      toolsEnabled: entry.toolsEnabled,
      toolChoice: entry.toolChoice,
      schemaEnforced: entry.schemaEnforced,
    })),
    [
      {
        sourceLabel: 'normal',
        schemaName: 'orvex_investigate_turn',
        toolsEnabled: true,
        toolChoice: 'tool_or_final',
        schemaEnforced: true,
      },
      {
        sourceLabel: 'repair_1',
        schemaName: 'orvex_investigate_turn',
        toolsEnabled: true,
        toolChoice: 'tool_or_final',
        schemaEnforced: true,
      },
      {
        sourceLabel: 'repair_2',
        schemaName: 'orvex_investigate_turn',
        toolsEnabled: true,
        toolChoice: 'tool_or_final',
        schemaEnforced: true,
      },
    ],
  );
  assert.ok(
    logs.some(
      (entry) =>
        entry.kind === 'recovery_final' &&
        entry.sourceLabel === 'repair_2' &&
        entry.accepted === true,
    ),
  );
  assert.deepEqual(result, {
    findings: [],
    summary: 'Repaired on second fresh generation.',
  });
});

test('#303 Flash investigate: two completed non-JSON replies then repair #2 TOOL then FINAL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-303-tool-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const currentValue = 1;\n');
  const originalFetch = globalThis.fetch;
  const { logs, restore } = captureInvestigateLogs();
  const requests: Array<Record<string, unknown>> = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (calls === 1 || calls === 2) {
      return responsesApiStream('completed non-JSON investigate reply');
    }
    if (calls === 3) {
      return responsesApiStream(
        '{"action":"tool","tool":{"name":"read_file","path":"a.ts"},"reason":"inspect after second repair"}',
      );
    }
    return responsesApiStream(
      '{"action":"done","findings":[],"summary":"Re-entered after repair #2."}',
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    restore();
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.test',
      api: 'responses',
      maxTokens: 28_000,
      maxSteps: 5,
    },
  );

  assert.equal(calls, 4);
  assert.equal(jsonSchemaName(requests[2] ?? {}), 'orvex_investigate_turn');
  assert.equal(jsonSchemaName(requests[3] ?? {}), 'orvex_investigate_turn');
  const repairTool = logs.find((entry) => entry.kind === 'recovery_tool');
  assert.equal(repairTool?.sourceLabel, 'repair_2');
  assert.equal(repairTool?.reenteredAgentLoop, true);
  assert.match(requestUserText(requests[3] ?? {}), /### Tool read_file/);
  assert.deepEqual(result, { findings: [], summary: 'Re-entered after repair #2.' });
});

test('#303 both semantic repairs invalid fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-303-fail-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return responsesApiStream('completed non-JSON investigate reply');
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runInvestigateReview(
    [
      {
        filename: 'a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
      },
    ],
    {
      cwd: root,
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.test',
      api: 'responses',
      maxSteps: 4,
    },
  );

  assert.equal(calls, 3, 'normal plus two repairs then fail closed');
  assert.deepEqual(result.findings, []);
  assert.match(result.summary ?? '', /could not be completed/i);
});
