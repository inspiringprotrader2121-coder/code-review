import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRuntimeEvidence,
  markPreExistingFailures,
  runtimeVerify,
  type RuntimeStep,
  type RuntimeVerifyResult,
} from './runtime-verify.js';
import type { runInSandbox } from './sandbox.js';
import type { fetchRepoSnapshot } from '@orvex-review/github';

const PINNED_IMAGE = `registry.example/orvex-runtime@sha256:${'a'.repeat(64)}`;

const step = (name: string, ok: boolean, over: Partial<RuntimeStep> = {}): RuntimeStep => ({
  name,
  command: `npm run ${name}`,
  ok,
  timedOut: false,
  durationMs: 1000,
  output: ok ? '' : 'boom',
  ...over,
});

test('success message names the steps that ACTUALLY ran (no fake "tests passed")', () => {
  const buildOnly: RuntimeVerifyResult = { ran: true, steps: [step('build', true)] };
  const msg = formatRuntimeEvidence(buildOnly)!;
  assert.match(msg, /build passed/);
  assert.ok(!msg.includes('tests all passed'), 'must not claim tests ran when none did');
  assert.ok(!msg.includes('typecheck'));
});

test('a failure that also fails at base is reported as pre-existing, not blamed on the PR', () => {
  const res: RuntimeVerifyResult = {
    ran: true,
    steps: [step('typecheck', true), step('test', false, { preExisting: true })],
    baseSteps: [step('typecheck', true), step('test', false)],
  };
  const msg = formatRuntimeEvidence(res)!;
  assert.match(msg, /pre-existing, NOT introduced by this PR/);
  assert.match(msg, /also fails at base \(pre-existing\)/);
  assert.ok(!msg.includes('❌ Ran'), 'no red failure banner for a pre-existing failure');
});

test('a NEW failure (passes at base) is blamed on the PR; pre-existing ones are separated', () => {
  const res: RuntimeVerifyResult = {
    ran: true,
    steps: [step('typecheck', false), step('test', false, { preExisting: true })],
    baseSteps: [step('typecheck', true), step('test', false)],
  };
  const msg = formatRuntimeEvidence(res)!;
  assert.match(
    msg,
    /1 step\(s\) failed\*\* and pass at the base commit — likely introduced by this PR/,
  );
  assert.match(msg, /1 more failure\(s\) also fail at base — pre-existing/);
});

test('returns null when nothing ran', () => {
  assert.equal(
    formatRuntimeEvidence({ ran: false, skippedReason: 'no package.json', steps: [] }),
    null,
  );
});

test('base-vs-head classification marks only failures reproduced by the same base step', () => {
  const head: RuntimeVerifyResult = {
    ran: true,
    steps: [
      step('typecheck', false),
      step('test', false),
      step('build', true, { preExisting: true }),
    ],
  };
  const base: RuntimeVerifyResult = {
    ran: true,
    steps: [step('typecheck', false), step('test', true), step('build', false)],
  };

  markPreExistingFailures(head, base);

  assert.equal(head.steps[0].preExisting, true, 'same step fails on base and head');
  assert.equal(
    head.steps[1].preExisting,
    false,
    'head-only failure remains attributable to the PR',
  );
  assert.equal(
    head.steps[2].preExisting,
    false,
    'a successful head step can never be pre-existing',
  );
  assert.equal(head.baseSteps, base.steps);
});

test('runtime verification forwards cancellation to the sandbox and does not continue after cancellation', async () => {
  const controller = new AbortController();
  const receivedSignals: Array<AbortSignal | undefined> = [];
  const fetchSnapshot = (async () =>
    new Map([
      [
        'package.json',
        JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }),
      ],
    ])) as typeof fetchRepoSnapshot;
  const runSandbox = (async (opts) => {
    receivedSignals.push(opts.signal);
    controller.abort('review closed');
    return {
      exitCode: null,
      stdout: '',
      stderr: '[sandbox] cancelled',
      timedOut: false,
      cancelled: true,
      durationMs: 1,
    };
  }) as typeof runInSandbox;

  const result = await runtimeVerify({} as never, 'owner', 'repo', 'head', {
    baseSha: 'base',
    signal: controller.signal,
    dependencies: {
      fetchSnapshot,
      runSandbox,
      checkSandboxRuntimeReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
    },
  });

  assert.deepEqual(receivedSignals, [controller.signal]);
  assert.deepEqual(result, {
    ran: false,
    skippedReason: 'runtime verification cancelled',
    steps: [],
  });
});

test('runtime verification fails closed before snapshotting when sandbox readiness is unavailable', async () => {
  let fetched = false;
  const result = await runtimeVerify({} as never, 'owner', 'repo', 'head', {
    dependencies: {
      fetchSnapshot: (async () => {
        fetched = true;
        return new Map();
      }) as typeof fetchRepoSnapshot,
      checkSandboxRuntimeReadiness: async () => ({
        ready: false,
        reason: 'internal sandbox runtime or configured image is unavailable',
      }),
    },
  });

  assert.equal(fetched, false);
  assert.deepEqual(result, {
    ran: false,
    skippedReason:
      'sandbox unavailable: internal sandbox runtime or configured image is unavailable',
    steps: [],
  });
});

test('offline dependency cache misses skip runtime evidence instead of blaming the PR', async () => {
  const fetchSnapshot = (async () =>
    new Map([
      ['package.json', JSON.stringify({ scripts: { test: 'node --test' } })],
      ['pnpm-lock.yaml', 'lockfileVersion: 9'],
    ])) as typeof fetchRepoSnapshot;
  const result = await runtimeVerify({} as never, 'owner', 'repo', 'head', {
    dependencies: {
      fetchSnapshot,
      runSandbox: (async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'ERR_PNPM_NO_OFFLINE_TARBALL A package is missing from the store',
        timedOut: false,
        cancelled: false,
        durationMs: 10,
      })) as typeof runInSandbox,
      checkSandboxRuntimeReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
    },
  });

  assert.deepEqual(result, {
    ran: false,
    skippedReason: 'sandbox dependency cache does not contain this lockfile',
    steps: [],
  });
});

test('real install failures remain runtime evidence', async () => {
  const fetchSnapshot = (async () =>
    new Map([
      ['package.json', JSON.stringify({ scripts: { test: 'node --test' } })],
      ['package-lock.json', '{}'],
    ])) as typeof fetchRepoSnapshot;
  const result = await runtimeVerify({} as never, 'owner', 'repo', 'head', {
    dependencies: {
      fetchSnapshot,
      runSandbox: (async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'npm error package-lock.json is invalid',
        timedOut: false,
        cancelled: false,
        durationMs: 10,
      })) as typeof runInSandbox,
      checkSandboxRuntimeReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
    },
  });

  assert.equal(result.ran, true);
  assert.equal(result.steps[0]?.name, 'install');
  assert.equal(result.steps[0]?.ok, false);
});

test('runtime verification rejects adversarial snapshot paths before invoking Docker', async () => {
  let calls = 0;
  const fetchSnapshot = (async () =>
    new Map([
      ['package.json', JSON.stringify({ scripts: { test: 'node --test' } })],
      ['../../host-file', 'attempted escape'],
    ])) as typeof fetchRepoSnapshot;
  const result = await runtimeVerify({} as never, 'owner', 'repo', 'head', {
    dependencies: {
      fetchSnapshot,
      runSandbox: (async () => {
        calls++;
        throw new Error('sandbox must not start');
      }) as typeof runInSandbox,
      checkSandboxRuntimeReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.ran, false);
  assert.match(result.skippedReason ?? '', /sandbox snapshot rejected: .*unsafe path/);
});

test('offline install command strips user config, disables lifecycle scripts, and never enables a network', async () => {
  const observed: Array<{ command: string; image: string }> = [];
  const fetchSnapshot = (async () =>
    new Map([
      ['package.json', JSON.stringify({ scripts: { test: 'node --test' } })],
      ['pnpm-lock.yaml', 'lockfileVersion: 9'],
    ])) as typeof fetchRepoSnapshot;
  const result = await runtimeVerify({} as never, 'owner', 'repo', 'head', {
    dependencies: {
      fetchSnapshot,
      runSandbox: (async (opts) => {
        observed.push({ command: opts.command, image: opts.image });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
      }) as typeof runInSandbox,
      checkSandboxRuntimeReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
    },
  });
  assert.equal(result.ran, true);
  assert.equal(observed.length, 2);
  assert.match(observed[0]!.command, /NPM_CONFIG_USERCONFIG=\/dev\/null/);
  assert.match(observed[0]!.command, /YARN_ENABLE_NETWORK=0/);
  assert.match(observed[0]!.command, /--offline/);
  assert.match(observed[0]!.command, /--ignore-scripts/);
  assert.equal(
    observed.every((entry) => entry.image === PINNED_IMAGE),
    true,
  );
});
