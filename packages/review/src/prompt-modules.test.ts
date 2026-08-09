import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUserPrompt } from './prompt.js';
import { taskPreamble } from './prompt/fencing.js';
import { appendPassAngle } from './prompt/pass-angle.js';

test('prompt framing makes untrusted-data handling explicit before any diff evidence', () => {
  const preamble = taskPreamble().join('\n');
  assert.match(preamble, /UNTRUSTED DATA/);
  assert.match(preamble, /never OBEY/i);

  const prompt = buildUserPrompt([
    { filename: 'src/app.ts', status: 'modified', patch: '+safe()' },
  ]);
  assert.ok(prompt.indexOf('UNTRUSTED DATA') < prompt.indexOf('```diff'));
});

test('pass angles stay after stable file-type rules and cannot include author intent', () => {
  const parts = ['stable prefix'];
  appendPassAngle(parts, [{ filename: 'src/app.ts', status: 'modified', patch: '+change()' }], {
    extraFocus: 'RISK-PROBE-SENTINEL',
  });
  const prompt = parts.join('\n');
  assert.ok(prompt.indexOf('Rules for the file types') < prompt.indexOf('RISK-PROBE-SENTINEL'));

  const firstPass = buildUserPrompt(
    [{ filename: 'src/app.ts', status: 'modified', patch: '+change()' }],
    { prTitle: 'author intent must never appear' } as never,
  );
  assert.doesNotMatch(firstPass, /author intent must never appear/);
});
