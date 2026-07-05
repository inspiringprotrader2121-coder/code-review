import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCheckboxLine,
  applyingLine,
  appliedLine,
  failedApplyLine,
  replaceApplyLine,
  parseApplyMarker,
  applyCheckboxChecked,
} from './format.js';

// The REAL fingerprint format (v<version>-<16 hex>) — using a bare 16-hex string
// here previously let a broken marker regex pass tests while failing in production.
const FP = 'v2-a1b2c3d4e5f60718';

test('apply button transitions idle → applying → applied, anchored by the marker', () => {
  const idle = applyCheckboxLine(FP, true);
  assert.ok(idle.startsWith(`- [ ] <!--orvex:apply:${FP}-->`));
  assert.ok(idle.includes('**Apply this fix**'));
  assert.equal(parseApplyMarker(idle), FP);

  const body = `finding text\n\n${idle}\n\n<sub>footer</sub>`;

  const applying = replaceApplyLine(body, applyingLine(FP, 'alice'));
  assert.ok(applying.includes('Applying fix'), 'shows applying state');
  assert.ok(applying.includes('@alice'), 'attributes the requester');
  assert.ok(!applying.includes('- [ ]'), 'checkbox removed while applying');
  assert.ok(applying.includes('footer'), 'rest of the comment is preserved');

  const applied = replaceApplyLine(applying, appliedLine(FP, 'abc1234'));
  assert.ok(applied.includes('Fix applied'), 'shows applied state');
  assert.ok(applied.includes('abc1234'), 'shows the commit sha');
  assert.ok(applied.includes('footer'));
});

test('a failed apply reverts to a tickable retry checkbox (not stuck on Applying)', () => {
  const applying = applyingLine(FP, 'bob');
  const reverted = replaceApplyLine(applying, failedApplyLine(FP, 'the branch moved'));
  assert.ok(reverted.startsWith('- [ ] '), 'is a checkbox again');
  assert.ok(reverted.includes('tick to retry'));
  assert.ok(reverted.includes('the branch moved'));
  // and it can be ticked again to re-trigger
  assert.ok(
    applyCheckboxChecked(`- [ ] <!--orvex:apply:${FP}-->`, `- [x] <!--orvex:apply:${FP}-->`),
    'retry checkbox is detectable when ticked',
  );
});

test('replaceApplyLine only touches the marked line', () => {
  const body = `line 1\n${applyCheckboxLine(FP, false)}\nline 3`;
  const out = replaceApplyLine(body, appliedLine(FP, 'deadbee'));
  assert.ok(out.startsWith('line 1\n'));
  assert.ok(out.endsWith('\nline 3'));
});
