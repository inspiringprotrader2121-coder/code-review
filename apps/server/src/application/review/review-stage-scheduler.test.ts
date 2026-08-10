import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedFile } from '@orvex-review/github';
import { groupApiCallsByProvider } from './review-provider-execution.js';
import { boundHighTierDiscoveryWorkloads, type ReviewCall } from './review-stage-scheduler.js';

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
      related: [{ path: 'src/related.ts', content: 'related' }],
      dependents: [{ path: 'src/dependent.ts', content: 'dependent' }],
      others: [{ path: 'src/other.ts', content: 'other' }],
      treePaths: ['src/file-0.ts', 'src/related.ts'],
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
  const sharded = boundHighTierDiscoveryWorkloads([luna, first, second, minimax], files);

  assert.equal(sharded[0], luna);
  assert.deepEqual(
    sharded[1]?.files?.map((file) => file.filename),
    ['src/file-0.ts', 'src/file-2.ts', 'src/file-4.ts'],
  );
  assert.deepEqual(
    sharded[2]?.files?.map((file) => file.filename),
    ['src/file-1.ts', 'src/file-3.ts'],
  );
  assert.equal(sharded[1]?.ctx.changedContents, undefined);
  assert.equal(sharded[2]?.ctx.changedContents, undefined);
  assert.equal(sharded[1]?.ctx.related, undefined);
  assert.equal(sharded[1]?.ctx.dependents, undefined);
  assert.equal(sharded[1]?.ctx.others, undefined);
  assert.equal(sharded[1]?.ctx.treePaths, undefined);
  assert.match(sharded[2]?.ctx.extraFocus ?? '', /REQUIRED DIFF-ONLY SHARD 2\/2/);
  assert.match(sharded[2]?.ctx.extraFocus ?? '', /reserve the final response.*JSON/);
  assert.deepEqual(
    sharded[3]?.files?.map((file) => file.filename),
    ['src/file-1.ts', 'src/file-3.ts'],
  );
  assert.equal(sharded[3]?.ctx.changedContents, undefined);
  assert.equal(sharded[3]?.ctx.related, undefined);
  assert.equal(sharded[3]?.ctx.dependents, undefined);
  assert.equal(sharded[3]?.ctx.others, undefined);
  assert.equal(sharded[3]?.ctx.treePaths, undefined);
  assert.match(sharded[3]?.ctx.extraFocus ?? '', /REQUIRED DIFF-ONLY BREADTH SHARD/);
});

test('lower-tier single DeepSeek and MiniMax reviewers still receive the full PR', () => {
  const only = call('deepseek-v4-flash', 1);
  const minimax = call('MiniMax-M3', 2);
  const calls = [only, minimax];
  const scheduled = boundHighTierDiscoveryWorkloads(calls, files);
  assert.equal(scheduled[0], only);
  assert.equal(scheduled[1], minimax);
});

test('same-provider review calls are independently scheduled behind provider admission', () => {
  const first = call('deepseek-v4-flash', 1);
  first.target.admissionBucket = 'deepseek';
  const second = call('deepseek-v4-flash', 2);
  second.target.admissionBucket = 'deepseek';
  const minimax = call('MiniMax-M3', 3);
  minimax.target.admissionBucket = 'minimax';

  assert.deepEqual(groupApiCallsByProvider([first, minimax, second]), [
    [first],
    [minimax],
    [second],
  ]);
});
