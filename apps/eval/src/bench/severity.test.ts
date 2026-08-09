import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityOf, sevRank, worseSev, sameClusterLine } from './severity.js';

test('explicit P-labels parse anywhere in the body', () => {
  assert.equal(severityOf('**P1** SQL injection in login'), 'P1');
  assert.equal(severityOf('something\nP3 — minor thing'), 'P3');
  assert.equal(severityOf('<img alt="P2"> description'), 'P2');
});

test('P0 folds into P1 (top of our taxonomy)', () => {
  assert.equal(severityOf('P0 — data loss on upgrade'), 'P1');
});

test('free-text severity words do NOT count — only the label region', () => {
  assert.equal(severityOf('This helper is not critical to the flow, but...'), null);
  assert.equal(severityOf('Consider whether this Bug matters. '.padStart(200, 'x ')), null);
  assert.equal(
    severityOf('A long explanation of why calling this a bug would be wrong '.padEnd(200, 'y')),
    null,
  );
});

test('label-region keywords parse (High/Medium/Low mapping)', () => {
  assert.equal(severityOf('Critical: session fixation in OAuth callback'), 'P1');
  assert.equal(severityOf('⚠️ High — race condition in queue claim'), 'P2');
  assert.equal(severityOf('Major: missing tenant filter'), 'P2');
  assert.equal(severityOf('Medium — unhandled empty array'), 'P3');
  assert.equal(severityOf('Minor: redundant await'), 'P3');
  assert.equal(severityOf('note: could rename for clarity'), 'info');
});

test('a "Severity: X" label parses even mid-body', () => {
  assert.equal(
    severityOf(
      'Some intro text. Severity: High. More text that is long enough to pass the head window '.padEnd(
        200,
        '.',
      ),
    ),
    'P2',
  );
});

test('sevRank / worseSev max-fold', () => {
  assert.equal(sevRank('P1'), 3);
  assert.equal(sevRank(null), 0);
  assert.equal(worseSev('P3', 'P1'), 'P1');
  assert.equal(worseSev('P2', null), 'P2');
});

test('sameClusterLine: ±5 window; null==null only merges within the same bot', () => {
  assert.equal(sameClusterLine(10, 14, false), true);
  assert.equal(sameClusterLine(10, 16, true), false);
  assert.equal(sameClusterLine(null, null, true), true, 'same bot unanchored dedup');
  assert.equal(sameClusterLine(null, null, false), false, 'cross-tool unanchored must NOT merge');
  assert.equal(sameClusterLine(null, 12, true), false, 'mixed anchored/unanchored never merge');
});

test('markdown emphasis does not hide a severity label (underscore is a word char)', () => {
  // CodeRabbit's real inline header. `/\bmajor\b/` cannot match `Major_`, so
  // this scored P3 via the unanchored `suggestion` token and the finding
  // silently left the "Orvex missed" ledger.
  assert.equal(severityOf('_🛠️ Refactor suggestion_ | _🟠 Major_'), 'P2');
  assert.equal(severityOf('_🟠 Major_'), 'P2');
  assert.equal(severityOf('_High_'), 'P2');
  assert.equal(severityOf('_Medium_'), 'P3');
  assert.equal(severityOf('_Low_'), 'info');
  assert.equal(severityOf('**Major**'), 'P2');
});

test('badge/table markup does not burn the 120-char head window', () => {
  // greptile/qodo lead with an <img> or <table>; the head slice used to be
  // taken on the RAW body, so the severity word fell outside it and the
  // finding was recorded as `unrated` and dropped from the actionable split.
  assert.equal(
    severityOf(
      '<img src="https://img.shields.io/badge/critical-red.svg" alt="badge"><br/><b>Critical:</b> unbounded loop',
    ),
    'P1',
  );
  assert.equal(
    severityOf('<table><tr><td>badge</td></tr></table>\n\nHigh severity: fix it.'),
    'P2',
  );
});

test('negated severity words are still stripped after markup removal', () => {
  assert.equal(severityOf('This is not critical at all, just a note:'), 'info');
});
