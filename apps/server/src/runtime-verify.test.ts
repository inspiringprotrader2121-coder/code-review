import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRuntimeEvidence,
  markPreExistingFailures,
  type RuntimeStep,
  type RuntimeVerifyResult,
} from './runtime-verify.js';

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
  assert.match(msg, /1 step\(s\) failed\*\* and pass at the base commit — likely introduced by this PR/);
  assert.match(msg, /1 more failure\(s\) also fail at base — pre-existing/);
});

test('returns null when nothing ran', () => {
  assert.equal(formatRuntimeEvidence({ ran: false, skippedReason: 'no package.json', steps: [] }), null);
});

test('base-vs-head classification marks only failures reproduced by the same base step', () => {
  const head: RuntimeVerifyResult = {
    ran: true,
    steps: [step('typecheck', false), step('test', false), step('build', true, { preExisting: true })],
  };
  const base: RuntimeVerifyResult = {
    ran: true,
    steps: [step('typecheck', false), step('test', true), step('build', false)],
  };

  markPreExistingFailures(head, base);

  assert.equal(head.steps[0].preExisting, true, 'same step fails on base and head');
  assert.equal(head.steps[1].preExisting, false, 'head-only failure remains attributable to the PR');
  assert.equal(head.steps[2].preExisting, false, 'a successful head step can never be pre-existing');
  assert.equal(head.baseSteps, base.steps);
});
