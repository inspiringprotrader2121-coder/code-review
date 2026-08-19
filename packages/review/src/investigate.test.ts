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
} from './investigate.js';

function compatibleChatStream(content: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
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
  assert.equal(formats[0]?.name, 'orvex_investigate_step');
  assert.equal(formats[1]?.type, 'json_schema');
  assert.equal(formats[1]?.name, 'orvex_investigate_final');
  const stepSchema = formats[0]?.schema as
    | { type?: string; required?: string[]; anyOf?: unknown }
    | undefined;
  assert.equal(stepSchema?.type, 'object');
  assert.deepEqual(stepSchema?.required, ['step']);
  assert.equal(stepSchema?.anyOf, undefined);
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
  assert.equal(requests[2]?.max_tokens, 8_000);
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

  assert.equal(calls, 4, 'primary and repair each stop after one no-progress continuation');
  assert.deepEqual(result.findings, []);
  assert.match(result.summary ?? '', /could not be completed/i);
});
