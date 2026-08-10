import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedFile } from '@orvex-review/github';
import { shardRepeatedDeepSeekCalls, type ReviewCall } from './review-stage-scheduler.js';

const files = Array.from({ length: 5 }, (_, index) => ({
  filename: `src/file-${index}.ts`,
  status: 'modified',
  patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}`,
})) as ChangedFile[];

function call(model: string, index: number): ReviewCall {
  return {
    label: `pass ${index}`,
    kind: 'pass',
    mode: 'api',
    ctx: {
      changedContents: files.map((file) => ({ path: file.filename, content: file.filename })),
    },
    target: { model, apiKey: 'test', api: 'chat' },
    tier: model.includes('deepseek') ? 'deepseek-flash' : 'standard',
    sample: 0,
  };
}

test('repeated required DeepSeek calls cover balanced disjoint shards', () => {
  const luna = call('gpt-5.6-luna', 1);
  const first = call('deepseek-v4-flash', 2);
  const second = call('deepseek-v4-flash', 3);
  const minimax = call('MiniMax-M3', 4);
  const sharded = shardRepeatedDeepSeekCalls([luna, first, second, minimax], files);

  assert.equal(sharded[0], luna);
  assert.equal(sharded[3], minimax);
  assert.deepEqual(
    sharded[1]?.files?.map((file) => file.filename),
    ['src/file-0.ts', 'src/file-2.ts', 'src/file-4.ts'],
  );
  assert.deepEqual(
    sharded[2]?.files?.map((file) => file.filename),
    ['src/file-1.ts', 'src/file-3.ts'],
  );
  assert.deepEqual(
    sharded[1]?.ctx.changedContents?.map((file) => file.path),
    ['src/file-0.ts', 'src/file-2.ts', 'src/file-4.ts'],
  );
  assert.match(sharded[2]?.ctx.extraFocus ?? '', /REQUIRED SHARD 2\/2/);
});

test('a single DeepSeek reviewer still receives the full PR', () => {
  const only = call('deepseek-v4-flash', 1);
  assert.equal(shardRepeatedDeepSeekCalls([only], files)[0], only);
});
