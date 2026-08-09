import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatInlineFinding,
  replaceApplyLine,
  applyCheckboxLine,
  failedApplyLine,
} from './format.js';

test('replaceApplyLine inserts $-sequences literally (no replacement-pattern corruption)', () => {
  const fp = 'v2-a1b2c3d4e5f60718';
  const body = `intro\n${applyCheckboxLine(fp, true)}\noutro`;
  // A failure reason containing `$\`` / `$&` must appear verbatim, not expand.
  const reason = "failed: $` and $& and $' in llm text";
  const out = replaceApplyLine(body, failedApplyLine(fp, reason));
  assert.match(out, /\$`/);
  assert.match(out, /\$&/);
  assert.match(out, /intro/);
  assert.match(out, /outro/);
});

// single-line fix with a matching anchored line → qualifies for a native GitHub suggestion
const base = {
  finding: {
    severity: 'P1',
    ruleId: 'llm.security',
    message: 'bug',
    fixedCode: 'safe()',
    originalCode: 'unsafe()',
    fingerprint: 'v2-a1b2c3d4e5f60718',
  },
  trigger: '@orvex',
  anchoredLine: 'const x = unsafe();',
};
// multi-line original → no native suggestion possible → the Orvex apply-checkbox
const multiline = {
  ...base,
  finding: { ...base.finding, originalCode: 'a()\nb()', fixedCode: 'x()\ny()' },
};
// anchored line does NOT contain originalCode → fall back to checkbox (P1-1)
const mismatchedAnchor = {
  ...base,
  anchoredLine: 'totally unrelated line',
};

const paid = { canAutofix: true };
const free = { canAutofix: false };

test('single-line fix with matching anchored line → INSTANT native suggestion, NOT the slow checkbox', () => {
  const body = formatInlineFinding({ ...base, ...paid });
  assert.match(
    body,
    /```suggestion\nconst x = safe\(\);\n```/,
    'native suggestion contains the full reconstructed line',
  );
  assert.match(body, /Apply instantly/i, 'points at the instant Commit-suggestion button');
  assert.doesNotMatch(body, /- \[ \]/, 'no slow apply-checkbox when a safe native button exists');
});

test('single-line fix with mismatched anchored line → checkbox, not a broken native suggestion (P1-1)', () => {
  const body = formatInlineFinding({ ...mismatchedAnchor, ...paid });
  assert.doesNotMatch(
    body,
    /```suggestion/,
    'no native suggestion when anchor does not contain originalCode',
  );
  assert.match(body, /<!--orvex:apply:v2-a1b2c3d4e5f60718-->/, 'falls back to apply-checkbox');
  assert.match(body, /- \[ \]/, 'a tickable checkbox is present');
});

test('relocated anchor → checkbox, not native suggestion (P1-1)', () => {
  const body = formatInlineFinding({ ...base, ...paid, lineRelocated: true });
  assert.doesNotMatch(body, /```suggestion/);
  assert.match(body, /- \[ \]/, 'checkbox because the anchor was snapped to a different line');
});

test('multi-line fix (no native suggestion) → the Orvex apply checkbox (paid)', () => {
  const body = formatInlineFinding({ ...multiline, ...paid });
  assert.match(body, /<!--orvex:apply:v2-a1b2c3d4e5f60718-->/);
  assert.match(body, /- \[ \]/, 'a tickable checkbox is present for the non-suggestion path');
});

test('free trial, single-line fix with matching anchored line: still gets the free native suggestion; no Orvex apply marker', () => {
  const body = formatInlineFinding({ ...base, ...free });
  assert.doesNotMatch(body, /<!--orvex:apply:/, 'no bot apply marker for free tier');
  assert.doesNotMatch(body, /- \[ \]/, 'no checkbox rendered');
  assert.match(
    body,
    /```suggestion/,
    'native suggestion is a GitHub feature, available to everyone',
  );
});

test('free trial, multi-line fix: no checkbox — an upgrade / apply-by-hand note', () => {
  const body = formatInlineFinding({ ...multiline, ...free });
  assert.doesNotMatch(body, /<!--orvex:apply:/);
  assert.doesNotMatch(body, /- \[ \]/, 'no checkbox rendered');
  assert.match(body, /upgrade/i, 'points the free user to upgrade / apply by hand');
});

test('P3-5: unbalanced triple-backtick fence in message is closed before the suggestion block', () => {
  const withFence = {
    ...base,
    finding: { ...base.finding, message: 'bug: ```js\nunsafe()' },
  };
  const body = formatInlineFinding({ ...withFence, ...paid });
  // Triple-backtick input is collapsed before rendering, so it cannot swallow
  // the suggestion opener in the first place.
  assert.doesNotMatch(body, /bug: ```/);
  assert.match(body, /unsafe\(\)\n\n```suggestion/, 'the suggestion remains a live GitHub block');
});
