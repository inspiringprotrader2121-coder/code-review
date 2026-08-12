import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedFile } from '@orvex-review/github';
import { buildUserPrompt } from '@orvex-review/review';
import {
  executeReviewProviderCalls,
  groupApiCallsByProvider,
  interleaveProviderLane,
  reviewProviderParallelism,
} from './review-provider-execution.js';
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
    target: {
      model,
      apiKey: 'test',
      api: 'chat',
      admissionBucket: model.includes('deepseek') ? 'deepseek' : 'minimax',
    },
    tier: model.includes('deepseek') ? 'deepseek-flash' : 'standard',
    sample: 0,
  };
}

test('required API stages each cover every complete bounded diff shard', () => {
  const luna = call('gpt-5.6-luna', 1);
  luna.mode = 'agentic';
  const first = call('deepseek-v4-flash', 2);
  const minimax = call('MiniMax-M3', 3);
  first.modelPassIndex = 1;
  first.passTag = 'deep-dive';
  minimax.modelPassIndex = 3;
  minimax.passTag = 'perf/completeness/api';
  const large = Array.from({ length: 12 }, (_, index) => ({
    filename: `src/large-${index}.ts`,
    status: 'modified',
    patch: `@@ -${index * 10 + 1},1 +${index * 10 + 1},1 @@\n-OLD_MARKER_${index}\n+NEW_MARKER_${index}\n${'+x'.repeat(1_400)}`,
  })) as ChangedFile[];
  const scheduled = boundHighTierDiscoveryWorkloads([luna, first, minimax], large);

  assert.equal(scheduled.filter((entry) => entry.mode === 'agentic').length, 1);
  const apiStages = [
    ['deep-dive', 1],
    ['perf/completeness/api', 3],
  ] as const;
  const chunksPerStage = scheduled.filter((entry) => entry.passTag === 'deep-dive').length;
  assert.ok(chunksPerStage > 1, 'large diff must fan out into several bounded chunks');
  for (const [tag, modelPassIndex] of apiStages) {
    const stageCalls = scheduled.filter(
      (entry) => entry.passTag === tag && entry.modelPassIndex === modelPassIndex,
    );
    assert.equal(stageCalls.length, chunksPerStage, `${tag} must cover every chunk`);
    const combined = stageCalls
      .flatMap((entry) => entry.files ?? [])
      .map((file) => file.patch)
      .join('\n');
    for (const index of [0, 4, 8, 11]) assert.match(combined, new RegExp(`NEW_MARKER_${index}`));
    for (const entry of stageCalls) {
      assert.equal(entry.ctx.promptProfile, 'focused');
      assert.equal(entry.ctx.diffBudgetChars, 24_000);
      assert.equal(entry.ctx.diffCoverage, 'require-complete');
      assert.equal(entry.ctx.changedContents, undefined);
      assert.equal(entry.ctx.related, undefined);
      assert.equal(entry.ctx.dependents, undefined);
      assert.equal(entry.ctx.others, undefined);
      assert.equal(entry.ctx.treePaths, undefined);
      assert.ok(entry.requiredCoverageKey);
      const prompt = buildUserPrompt(entry.files ?? [], entry.ctx);
      assert.doesNotMatch(prompt, /diff chars omitted; sampled start and end/);
      assert.doesNotMatch(prompt, /Focused source context|Cross-file coverage notice/);
      if (tag === 'deep-dive') {
        assert.match(prompt, /removed or weakened guards/);
        assert.match(prompt, /visible callers\/tests\/contracts/);
      }
    }
  }
});

test('denser focused packing covers every hunk with fewer shards', () => {
  const first = call('deepseek-v4-flash', 1);
  first.modelPassIndex = 1;
  first.passTag = 'deep-dive';
  const files = Array.from({ length: 6 }, (_, index) => ({
    filename: `src/pack-${index}.ts`,
    status: 'modified',
    patch: `@@ -1 +1 @@\n-OLD_${index}\n+NEW_${index}\n${'+y'.repeat(2_000)}`,
  })) as ChangedFile[];
  const scheduled = boundHighTierDiscoveryWorkloads([first], files);
  const chunks = scheduled.filter((entry) => entry.passTag === 'deep-dive');
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.length <= 3, `expected denser packing into <=3 shards, got ${chunks.length}`);
  const combined = chunks
    .flatMap((entry) => entry.files ?? [])
    .map((file) => file.patch)
    .join('\n');
  for (const index of [0, 2, 5]) assert.match(combined, new RegExp(`NEW_${index}`));
  assert.ok(chunks.every((entry) => entry.ctx.diffBudgetChars === 24_000));
});

test('lower-tier required DeepSeek and MiniMax calls also fan out without sampling', () => {
  const only = call('deepseek-v4-flash', 1);
  const minimax = call('MiniMax-M3', 2);
  only.modelPassIndex = 0;
  minimax.modelPassIndex = 1;
  const large = Array.from({ length: 10 }, (_, index) => ({
    filename: `src/lower-${index}.ts`,
    status: 'modified',
    patch: `@@ -1 +1 @@\n-OLD_${index}\n+NEW_${index}\n${'+x'.repeat(1_700)}`,
  })) as ChangedFile[];
  const scheduled = boundHighTierDiscoveryWorkloads([only, minimax], large);
  const flashCalls = scheduled.filter((entry) => entry.target.model === only.target.model);
  const minimaxCalls = scheduled.filter((entry) => entry.target.model === minimax.target.model);
  assert.ok(flashCalls.length > 1);
  assert.equal(minimaxCalls.length, flashCalls.length);
  assert.ok(scheduled.every((entry) => entry.requiredCoverageKey));
});

test('same-provider review calls retain a provider lane and alternate reviewer lenses by shard', () => {
  const first = call('deepseek-v4-flash', 1);
  first.target.admissionBucket = 'deepseek';
  first.modelPassIndex = 1;
  first.passTag = 'deep-dive';
  const second = call('deepseek-v4-flash', 2);
  second.target.admissionBucket = 'deepseek';
  second.modelPassIndex = 2;
  second.passTag = 'risk-hunt';
  const third = call('deepseek-v4-flash', 3);
  third.target.admissionBucket = 'deepseek';
  third.modelPassIndex = 1;
  third.passTag = 'deep-dive';
  const minimax = call('MiniMax-M3', 3);
  minimax.target.admissionBucket = 'minimax';

  assert.deepEqual(groupApiCallsByProvider([first, minimax, second, third]), [
    [first, second, third],
    [minimax],
  ]);
  assert.deepEqual(interleaveProviderLane([first, third, second]), [first, second, third]);
  assert.equal(reviewProviderParallelism(8), 8);
  assert.equal(reviewProviderParallelism(8, { active: 10, limit: 128 }), 8);
  assert.equal(reviewProviderParallelism(8, { active: 120, limit: 128 }), 1);
  assert.ok(reviewProviderParallelism(8, { active: 100, limit: 128 }) <= 4);
});

test('an idle large review fans out same-provider shards while retaining a bounded lane', async () => {
  const first = call('deepseek-v4-flash', 1);
  first.target.admissionBucket = 'deepseek';
  first.modelPassIndex = 1;
  first.passTag = 'deep-dive';
  const second = call('deepseek-v4-flash', 2);
  second.target.admissionBucket = 'deepseek';
  second.modelPassIndex = 2;
  second.passTag = 'risk-hunt';
  const third = call('deepseek-v4-flash', 3);
  third.target.admissionBucket = 'deepseek';
  third.modelPassIndex = 1;
  third.passTag = 'deep-dive';
  const minimax = call('MiniMax-M3', 4);
  minimax.target.admissionBucket = 'minimax';
  const started: string[] = [];

  await executeReviewProviderCalls({
    calls: [first, third, minimax, second],
    filesForLlm: [],
    filesForInvestigate: [],
    providers: {
      async runCodexReview() {
        throw new Error('not used');
      },
      async runReview() {
        return { findings: [] };
      },
    },
    contextRun: async (_context, _target, _tier, name) => {
      started.push(name);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { findings: [] };
    },
    repoDirectory: null,
    repoId: 'acme/repo',
    signal: new AbortController().signal,
    isCancelled: () => false,
    onUsageFor: () => () => {},
    onAttemptFor: () => () => {},
    tagFindings: () => {},
    mapConcurrent: async (items, limit, run) => {
      const results: unknown[] = [];
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
          for (;;) {
            const current = index++;
            if (current >= items.length) return;
            results[current] = await run(items[current]!, current);
          }
        }),
      );
      return results as never;
    },
    apiConcurrency: 8,
  });

  assert.deepEqual(
    new Set(started),
    new Set([first.label, second.label, third.label, minimax.label]),
  );
});

test('six concurrent reviews keep independent provider chunks in parallel', async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let allStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });

  const reviews = Array.from({ length: 6 }, (_, reviewIndex) => {
    const calls = Array.from({ length: 4 }, (_, callIndex) => {
      const entry = call('deepseek-v4-flash', callIndex + 1);
      entry.label = `review ${reviewIndex + 1} chunk ${callIndex + 1}`;
      entry.modelPassIndex = 1;
      entry.passTag = 'deep-dive';
      return entry;
    });
    return executeReviewProviderCalls({
      calls,
      filesForLlm: [],
      filesForInvestigate: [],
      providers: {
        async runCodexReview() {
          throw new Error('not used');
        },
        async runReview() {
          return { findings: [] };
        },
      },
      contextRun: async () => {
        active++;
        peak = Math.max(peak, active);
        if (active === 24) allStarted();
        await gate;
        active--;
        return { findings: [] };
      },
      repoDirectory: null,
      repoId: `acme/repo-${reviewIndex + 1}`,
      signal: new AbortController().signal,
      isCancelled: () => false,
      onUsageFor: () => () => {},
      onAttemptFor: () => () => {},
      tagFindings: () => {},
      mapConcurrent: async (items, limit, run) => {
        const results: unknown[] = [];
        let index = 0;
        await Promise.all(
          Array.from({ length: Math.min(limit, items.length) }, async () => {
            for (;;) {
              const current = index++;
              if (current >= items.length) return;
              results[current] = await run(items[current]!, current);
            }
          }),
        );
        return results as never;
      },
      apiConcurrency: 8,
    });
  });

  await started;
  assert.equal(peak, 24, 'six reviews can each fan out four independent DeepSeek chunks');
  release();
  await Promise.all(reviews);
});

test('agentic reviews start a fresh Codex thread in the isolated container', async () => {
  const agentic = call('gpt-5.6-luna', 1);
  agentic.mode = 'agentic';
  agentic.target = {
    apiKey: 'test',
    model: 'gpt-5.6-luna',
    transport: 'codex-cli',
    admissionBucket: 'luna',
    thinking: true,
    reasoningEffort: 'max',
  };
  const receivedOptions: Array<Record<string, unknown>> = [];

  const outcomes = await executeReviewProviderCalls({
    calls: [agentic],
    filesForLlm: [],
    filesForInvestigate: [],
    providers: {
      async runCodexReview(_files, _target, options) {
        receivedOptions.push(options as Record<string, unknown>);
        return { response: { findings: [], summary: 'fresh thread' }, threadId: 'new-thread' };
      },
      async runReview() {
        return { findings: [] };
      },
    },
    contextRun: async () => ({ findings: [] }),
    repoDirectory: '/tmp/isolated-checkout',
    repoId: 'acme/repo',
    signal: new AbortController().signal,
    isCancelled: () => false,
    onUsageFor: () => () => {},
    onAttemptFor: () => () => {},
    tagFindings: () => {},
    mapConcurrent: async (items, _limit, run) => Promise.all(items.map(run)),
    apiConcurrency: 1,
  });

  assert.equal(outcomes[0]?.ok, true);
  assert.equal(receivedOptions.length, 1);
  assert.equal('threadId' in (receivedOptions[0] ?? {}), false);
});
