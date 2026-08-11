import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChangedFile } from '@orvex-review/github';
import { buildUserPrompt } from '@orvex-review/review';
import {
  executeReviewProviderCalls,
  groupApiCallsByProvider,
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
    target: { model, apiKey: 'test', api: 'chat' },
    tier: model.includes('deepseek') ? 'deepseek-flash' : 'standard',
    sample: 0,
  };
}

test('required API stages each cover every complete bounded diff shard', () => {
  const luna = call('gpt-5.6-luna', 1);
  luna.mode = 'agentic';
  const first = call('deepseek-v4-flash', 2);
  const second = call('deepseek-v4-flash', 3);
  const minimax = call('MiniMax-M3', 4);
  first.modelPassIndex = 1;
  first.passTag = 'deep-dive';
  second.modelPassIndex = 2;
  second.passTag = 'removed-behavior/callers';
  minimax.modelPassIndex = 3;
  minimax.passTag = 'perf/completeness/api';
  const large = Array.from({ length: 12 }, (_, index) => ({
    filename: `src/large-${index}.ts`,
    status: 'modified',
    patch: `@@ -${index * 10 + 1},1 +${index * 10 + 1},1 @@\n-OLD_MARKER_${index}\n+NEW_MARKER_${index}\n${'+x'.repeat(1_400)}`,
  })) as ChangedFile[];
  const scheduled = boundHighTierDiscoveryWorkloads([luna, first, second, minimax], large);

  assert.equal(scheduled.filter((entry) => entry.mode === 'agentic').length, 1);
  const apiStages = [
    ['deep-dive', 1],
    ['removed-behavior/callers', 2],
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
      assert.equal(entry.ctx.diffBudgetChars, 14_000);
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
    }
  }
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

test('same-provider review calls share a per-review lane while independent providers run separately', () => {
  const first = call('deepseek-v4-flash', 1);
  first.target.admissionBucket = 'deepseek';
  const second = call('deepseek-v4-flash', 2);
  second.target.admissionBucket = 'deepseek';
  const minimax = call('MiniMax-M3', 3);
  minimax.target.admissionBucket = 'minimax';

  assert.deepEqual(groupApiCallsByProvider([first, minimax, second]), [[first, second], [minimax]]);
});

test('same-provider lanes do not overlap while a different provider starts promptly', async () => {
  const first = call('deepseek-v4-flash', 1);
  first.target.admissionBucket = 'deepseek';
  const second = call('deepseek-v4-flash', 2);
  second.target.admissionBucket = 'deepseek';
  const minimax = call('MiniMax-M3', 3);
  minimax.target.admissionBucket = 'minimax';
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let minimaxStarted!: () => void;
  const minimaxStartedPromise = new Promise<void>((resolve) => {
    minimaxStarted = resolve;
  });

  const running = executeReviewProviderCalls({
    calls: [first, minimax, second],
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
      if (name === first.label) {
        firstStarted();
        await firstReleased;
      }
      if (name === minimax.label) minimaxStarted();
      return { findings: [] };
    },
    repoDirectory: null,
    repoId: 'acme/repo',
    signal: new AbortController().signal,
    isCancelled: () => false,
    onUsageFor: () => () => {},
    onAttemptFor: () => () => {},
    tagFindings: () => {},
    mapConcurrent: async (items, _limit, run) => Promise.all(items.map(run)),
    apiConcurrency: 2,
  });

  await Promise.all([firstStartedPromise, minimaxStartedPromise]);
  assert.deepEqual(started.sort(), [first.label, minimax.label].sort());
  releaseFirst();
  await running;
  assert.equal(started.at(-1), second.label);
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
