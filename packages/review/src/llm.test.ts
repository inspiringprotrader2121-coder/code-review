import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FindingJsonSchema, LlmReviewResponseSchema } from './types.js';
import {
  interpretReviewContract,
  normalizeLlmResponse,
  parseReviewJson,
  runLlmReview,
} from './llm.js';
import { JsonContractMismatchError } from './llm-client.js';
import type { TextModelRunRequest } from './providers/types.js';

test('normalizeLlmResponse maps MiniMax severity vocabulary to P-levels', () => {
  const raw = {
    findings: [
      {
        file: 'a.ts',
        line: 1,
        severity: 'critical',
        category: 'security',
        message: 'rce',
        confidence: 0.9,
      },
      { file: 'b.ts', line: 2, severity: 'high', category: 'bug', message: 'npe', confidence: 0.8 },
      {
        file: 'c.ts',
        line: 3,
        severity: 'medium',
        category: 'style',
        message: 'nit',
        confidence: 0.7,
      },
      { file: 'd.ts', severity: 'info', category: 'note', message: 'fyi', confidence: 0.6 },
    ],
  };
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(raw));
  assert.deepEqual(
    parsed.findings.map((f) => f.severity),
    ['P1', 'P2', 'P3', 'info'],
  );
});

test('normalizeLlmResponse accepts alternate field names', () => {
  const raw = {
    issues: [
      {
        path: 'x.ts',
        line_number: 5,
        priority: 'blocker',
        type: 'security',
        description: 'bad',
        score: 0.95,
        fix: 'do this',
      },
    ],
  };
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(raw));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].file, 'x.ts');
  assert.equal(parsed.findings[0].line, 5);
  assert.equal(parsed.findings[0].severity, 'P1');
  assert.equal(parsed.findings[0].category, 'security');
  assert.equal(parsed.findings[0].message, 'bad');
  assert.equal(parsed.findings[0].suggestion, 'do this');
});

test('normalizeLlmResponse drops findings missing message or file', () => {
  const raw = {
    findings: [
      { file: 'a.ts', severity: 'high' }, // no message
      { message: 'orphan', severity: 'high' }, // no file
      { file: 'ok.ts', message: 'keep', severity: 'low', confidence: 0.5 },
    ],
  };
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(raw));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].file, 'ok.ts');
});

test('normalizeLlmResponse rejects garbage JSON that drops every finding', () => {
  assert.throws(
    () =>
      normalizeLlmResponse({
        findings: [{ file: 'a.ts', severity: 'high' }, { message: 'orphan' }],
      }),
    /no usable findings/,
  );
  assert.throws(() => normalizeLlmResponse({ issues: [{ foo: 1 }] }), /no usable findings/);
  assert.deepEqual(normalizeLlmResponse({ findings: [], summary: 'clean' }), {
    findings: [],
    summary: 'clean',
  });
});

test('structured finding schema rejects blank file and message values', () => {
  const properties = FindingJsonSchema.properties as
    | { file?: { pattern?: string }; message?: { pattern?: string } }
    | undefined;
  const filePattern = new RegExp(properties?.file?.pattern ?? '');
  const messagePattern = new RegExp(properties?.message?.pattern ?? '');
  assert.equal(filePattern.test('   '), false);
  assert.equal(messagePattern.test('\n\t'), false);
  assert.equal(filePattern.test('src/a.ts'), true);
  assert.equal(messagePattern.test('Concrete failure'), true);
});

test('deleted files with patches are sent to discovery instead of faking an empty pass', async () => {
  let user = '';
  const result = await runLlmReview(
    [{ filename: 'gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-old\n' }],
    {
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      target: {
        transport: 'compatible-chat',
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
      },
      runner: {
        transport: 'compatible-chat',
        async run(request) {
          user = request.user;
          return JSON.stringify({ findings: [], summary: 'deleted' });
        },
      },
    },
  );
  assert.match(user, /gone.ts/);
  assert.equal(result.summary, 'deleted');
});

test('Flash discovery sends the review schema through Responses', async () => {
  let request: TextModelRunRequest | undefined;
  const result = await runLlmReview(
    [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
    {
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      target: {
        transport: 'responses',
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
      },
      runner: {
        transport: 'responses',
        async run(value) {
          request = value;
          return '{"findings":[],"summary":"clean"}';
        },
      },
    },
  );

  assert.equal(result.summary, 'clean');
  assert.equal(request?.jsonSchema?.name, 'orvex_review');
  assert.deepEqual((request?.jsonSchema?.schema as { required?: string[] } | undefined)?.required, [
    'findings',
    'summary',
  ]);
  assert.equal(request?.jsonContractPrefix, '{"findings":');
});

test('parseReviewJson requires a findings or issues array', () => {
  assert.throws(() => parseReviewJson('{}'), /missing findings\/issues/);
  assert.throws(() => parseReviewJson('{"summary":"looks good"}'), /missing findings\/issues/);
  assert.throws(() => parseReviewJson('{"verdicts":[]}'), /missing findings\/issues/);
  assert.deepEqual(parseReviewJson('{"findings":[],"summary":"clean"}'), {
    findings: [],
    summary: 'clean',
  });
});

test('parseReviewJson keeps a valid empty pass distinct from unusable findings', () => {
  assert.deepEqual(parseReviewJson('{"findings":[],"summary":"No actionable issues"}'), {
    findings: [],
    summary: 'No actionable issues',
  });
  assert.throws(
    () => parseReviewJson('{"findings":[{"file":"","line":null,"message":""}]}'),
    /no usable findings/,
  );
  assert.throws(
    () => parseReviewJson('{"findings":[],"summary":"Found 1 P1 SQL injection in auth.ts"}'),
    /summary claims findings/,
  );
});

test('parseReviewJson keeps usable findings when one sibling is malformed', () => {
  const parsed = parseReviewJson(
    JSON.stringify({
      findings: [
        { file: 'a.ts', line: 1, message: 'real bug', severity: 'high', confidence: 0.9 },
        { file: '', message: '', severity: 'high' },
        { message: 'orphan without a file', severity: 'high' },
      ],
      summary: 'one real issue',
    }),
  );
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.file, 'a.ts');
});

test('interpretReviewContract separates #311 unusable findings from a valid empty pass', () => {
  const empty = interpretReviewContract('{"findings":[],"summary":"No actionable issues found."}');
  assert.equal(empty.ok, true);
  assert.equal(empty.usableFindingCount, 0);
  assert.equal(empty.rejectedFindingCount, 0);

  const unusable = interpretReviewContract(
    '{"findings":[{"file":"","line":null,"message":""}],"summary":"There is a serious issue."}',
  );
  assert.equal(unusable.ok, false);
  assert.match(unusable.error?.message ?? '', /no usable findings/);
  assert.equal(unusable.coverageFailure, 'all_findings_unusable');
  assert.equal(unusable.rejectedFindingCount, 1);

  const missing = interpretReviewContract('This change looks safe overall.');
  assert.equal(missing.ok, false);
  assert.equal(missing.coverageFailure, 'no_parseable_review_json');
});

test('verifier-shaped JSON is not a successful discovery pass', async () => {
  await assert.rejects(
    () =>
      runLlmReview(
        [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
        {
          apiKey: 'test-key',
          model: 'deepseek-v4-flash',
          target: {
            transport: 'compatible-chat',
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
          },
          runner: {
            transport: 'compatible-chat',
            async run() {
              return JSON.stringify({ verdicts: [] });
            },
          },
        },
      ),
    /missing findings\/issues/,
  );
});

test('normalizeLlmResponse defaults unknown severity to info (fail toward nitpick) and clamps confidence', () => {
  const raw = { findings: [{ file: 'a.ts', message: 'm', severity: 'weird', confidence: 5 }] };
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(raw));
  // Unknown/unrecognized severity → info, NOT P3 (P3 now means MEDIUM = a real bug).
  assert.equal(parsed.findings[0].severity, 'info');
  assert.equal(parsed.findings[0].confidence, 1);
  assert.equal(parsed.findings[0].category, 'general');
});

test('an invalid discovery response uses bounded fresh semantic repairs then fails the pass', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    calls++;
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'not valid json' } }] })}\n\n`,
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
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () =>
      runLlmReview(
        [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
        {
          apiKey: 'test-key',
          model: 'MiniMax-M3',
          baseUrl: 'https://minimax.test/v1',
          api: 'chat',
          maxTokens: 16_000,
        },
      ),
    /JSON contract mismatch/,
  );

  assert.equal(calls, 3, 'primary plus two bounded fresh semantic repairs');
  const thinkingMode = (body: Record<string, unknown>) =>
    (body.chat_template_kwargs as { thinking_mode?: string } | undefined)?.thinking_mode;
  assert.equal(thinkingMode(bodies[0]!), 'enabled');
  assert.equal(thinkingMode(bodies[1]!), 'disabled');
  assert.equal(thinkingMode(bodies[2]!), 'disabled');
  const repairMessages = bodies[1]?.messages as Array<{ role: string; content: string }>;
  assert.equal(
    repairMessages.some((message) => message.role === 'assistant'),
    false,
  );
  assert.match(
    repairMessages.at(-1)?.content ?? '',
    /did not satisfy the required review JSON schema/i,
  );
});

test('#323 MiniMax end_turn prose is repaired with a fresh final object, not continuation', async () => {
  const users: string[] = [];
  let calls = 0;
  const result = await runLlmReview(
    [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
    {
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      target: {
        transport: 'anthropic',
        apiKey: 'test-key',
        model: 'MiniMax-M3',
      },
      runner: {
        transport: 'anthropic',
        async run(request) {
          users.push(request.user);
          calls++;
          if (calls === 1) {
            throw new JsonContractMismatchError(
              'This change looks safe overall. No blocking issues.',
              {
                failureClass: 'complete_non_json',
                recoveryMode: 'fresh_semantic_repair',
                parseResult: 'invalid',
                stopReason: 'end_turn',
              },
            );
          }
          assert.equal(request.thinking, false, 'repair is answer-only');
          return '{"findings":[],"summary":"No actionable issues found."}';
        },
      },
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary, 'No actionable issues found.');
  assert.doesNotMatch(users[0] ?? '', /did not satisfy the required review JSON schema/i);
  assert.match(users[1] ?? '', /did not satisfy the required review JSON schema/i);
  assert.match(users[1] ?? '', /Do not continue the previous response/i);
  assert.match(users[1] ?? '', /This change looks safe overall/);
});

test('#323 empty MiniMax findings after semantic repair still complete the required pass', async () => {
  const result = await runLlmReview(
    [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
    {
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      target: {
        transport: 'anthropic',
        apiKey: 'test-key',
        model: 'MiniMax-M3',
      },
      runner: {
        transport: 'anthropic',
        async run(request) {
          if (!request.user.includes('did not satisfy the required review JSON schema')) {
            throw new JsonContractMismatchError('{"result":"looks good"}', {
              failureClass: 'schema_mismatch',
              recoveryMode: 'fresh_semantic_repair',
              parseResult: 'schema_mismatch',
              stopReason: 'end_turn',
            });
          }
          return '{"findings":[],"summary":"clean"}';
        },
      },
    },
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary, 'clean');
});

test('required complete-diff context reaches the provider prompt unchanged', async () => {
  let user = '';
  const result = await runLlmReview(
    [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+COMPLETE_MARKER' }],
    {
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      context: { diffBudgetChars: 100, diffCoverage: 'require-complete' },
      target: {
        transport: 'compatible-chat',
        apiKey: 'test-key',
        model: 'deepseek-v4-flash',
      },
      runner: {
        transport: 'compatible-chat',
        async run(request) {
          user = request.user;
          return JSON.stringify({ findings: [], summary: 'complete' });
        },
      },
    },
  );

  assert.equal(result.summary, 'complete');
  assert.match(user, /COMPLETE_MARKER/);
  assert.doesNotMatch(user, /diff chars omitted; sampled start and end/);
});
