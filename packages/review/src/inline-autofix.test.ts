import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInlineFinding, replaceApplyLine, applyCheckboxLine, failedApplyLine } from './format.js';

test('replaceApplyLine inserts $-sequences literally (no replacement-pattern corruption)', () => {
  const fp = 'v2-a1b2c3d4e5f60718';
  const body = `intro\n${applyCheckboxLine(fp, true)}\noutro`;
  // A failure reason containing `$\`` / `$&` must appear verbatim, not expand.
  const reason = 'failed: $` and $& and $\' in llm text';
  const out = replaceApplyLine(body, failedApplyLine(fp, reason));
  assert.match(out, /\$`/);
  assert.match(out, /\$&/);
  assert.match(out, /intro/);
  assert.match(out, /outro/);
});

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
};

test('paid plan (canAutofix true/default) renders the apply checkbox', () => {
  const body = formatInlineFinding({ ...base, canAutofix: true });
  assert.match(body, /<!--orvex:apply:v2-a1b2c3d4e5f60718-->/);
  assert.match(body, /- \[ \]/, 'a tickable checkbox is present');
  // default (no flag) also renders it, for back-compat
  assert.match(formatInlineFinding(base), /<!--orvex:apply:/);
});

test('free trial (canAutofix false) renders NO apply checkbox — only a manual/upgrade note', () => {
  const body = formatInlineFinding({ ...base, canAutofix: false });
  assert.doesNotMatch(body, /<!--orvex:apply:/, 'no apply marker → nothing to get stuck on "Applying"');
  assert.doesNotMatch(body, /- \[ \]/, 'no checkbox rendered');
  assert.match(body, /upgrade/i, 'points the free user to upgrade / apply by hand');
  // the inline suggestion is still shown so free users can apply by hand
  assert.match(body, /```suggestion/);
});
