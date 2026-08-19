import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonLoose, jsonContractMissing, jsonFinishPrefix } from './llm-client.js';

test('extracts a plain JSON object', () => {
  assert.deepEqual(extractJsonLoose('{"findings":[],"summary":"ok"}'), {
    findings: [],
    summary: 'ok',
  });
});

test('prefers an explicit ```json fence over an earlier ```bash block', () => {
  // This is the exact shape that crashed review #15: the model answered with a
  // bash/nginx code block BEFORE the JSON. Naive `/```(?:json)?/` extraction
  // grabbed "bash\nNGINX…" and threw "Unexpected token 'b'… is not valid JSON".
  const reply = [
    'Here is the config I referenced:',
    '```bash',
    'NGINX -s reload',
    'location / { proxy_pass http://app; }',
    '```',
    'And the review:',
    '```json',
    '{"findings":[{"file":"nginx.conf","message":"missing header"}],"summary":"one issue"}',
    '```',
  ].join('\n');
  const out = extractJsonLoose(reply) as { findings: unknown[]; summary: string };
  assert.equal(out.summary, 'one issue');
  assert.equal(out.findings.length, 1);
});

test('falls back to the outermost object when there is no json fence', () => {
  const reply = 'Sure — here you go:\n{"findings":[],"summary":"done"}\nHope that helps!';
  assert.deepEqual(extractJsonLoose(reply), { findings: [], summary: 'done' });
});

test('ignores a leading non-JSON fenced block and finds the bare object', () => {
  const reply = '```bash\nNGINX -t\n```\n{"findings":[],"summary":"clean"}';
  assert.deepEqual(extractJsonLoose(reply), { findings: [], summary: 'clean' });
});

test('jsonContractMissing continues when parseable JSON is missing the review contract', () => {
  assert.equal(jsonContractMissing('{"findings":[],"summary":"ok"}'), false);
  assert.equal(jsonContractMissing('{"verdicts":[]}'), false);
  assert.equal(jsonContractMissing('{}'), true);
  assert.equal(jsonContractMissing('{"summary":"looks good"}'), true);
});

test('jsonContractMissing accepts an investigation tool action only when requested', () => {
  const action = '{"action":"tool","tool":{"name":"read_file","path":"src/a.ts"}}';
  const step = `{"step":${action}}`;
  assert.equal(jsonContractMissing(action), true);
  assert.equal(jsonContractMissing(action, ['action']), false);
  assert.equal(jsonContractMissing(step, ['step']), false);
  assert.equal(jsonContractMissing('{"findings":[]}', ['verdicts']), true);
  assert.equal(jsonContractMissing('{"clusters":[]}', ['clusters']), false);
});

test('strips <think> reasoning before parsing', () => {
  const reply = '<think>let me consider the diff</think>{"findings":[],"summary":"s"}';
  assert.deepEqual(extractJsonLoose(reply), { findings: [], summary: 's' });
});

test('throws (does not return garbage) when nothing parses', () => {
  assert.throws(() => extractJsonLoose('```bash\nNGINX -s reload\n```'), /no parseable JSON/);
});

test('jsonFinishPrefix continues from a truncated object and does not rewrite complete JSON', () => {
  assert.equal(jsonFinishPrefix('no json here'), '{"findings":');
  assert.equal(jsonFinishPrefix('no json here', ''), null);
  assert.equal(jsonFinishPrefix('<think>x</think>{"findings":[{"file":'), '{"findings":[{"file":');
  assert.equal(jsonFinishPrefix('{"findings":[],"summary":"ok"}'), null);
  assert.equal(
    jsonFinishPrefix('{"action":"final","findings":[],"summary":"ok"}', '{"step":{"action":'),
    null,
  );
  assert.equal(jsonFinishPrefix('no json here', '{"verdicts":'), '{"verdicts":');
});
