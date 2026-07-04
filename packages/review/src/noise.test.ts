import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSelfNegatingFindings } from './noise.js';
import type { ReviewFinding } from './finding.js';

function f(partial: Partial<ReviewFinding>): ReviewFinding {
  return {
    file: 'a.ts',
    line: 1,
    severity: 'P3',
    category: 'general',
    message: '',
    confidence: 0.8,
    ruleId: 'llm.general',
    ...partial,
  };
}

test('drops findings that admit their own impact is nil', () => {
  const findings = [
    f({ message: 'Historical rows would still match — realistically the source never contains these chars, so impact is nil; flagging as P3 to call out the gap.' }),
    f({ message: 'The added blank line is harmless.' }),
    f({ severity: 'P1', message: 'poll() references undefined upstreamName — crashes every 20 failures.' }),
  ];
  const { kept, dropped } = dropSelfNegatingFindings(findings);
  assert.equal(dropped.length, 2);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].severity, 'P1');
});

test('keeps a hedging P1/P2 (likely mis-severitied, not noise)', () => {
  const findings = [
    f({ severity: 'P2', message: 'This is fine for Stripe IDs but the tenant walk is bypassable with password=x.' }),
  ];
  const { kept } = dropSelfNegatingFindings(findings);
  // "is fine for" is a self-negating phrase, but on a P2 we keep it for re-triage
  assert.equal(kept.length, 1);
});

test('drops low-severity nitpick openers', () => {
  const findings = [
    f({ severity: 'info', message: 'Nit: consider renaming this variable.' }),
    f({ severity: 'P3', message: 'Consider extracting this into a helper.' }),
    f({ severity: 'P2', message: 'Null deref when cache is cold.' }),
  ];
  const { kept, dropped } = dropSelfNegatingFindings(findings);
  assert.equal(dropped.length, 2);
  assert.equal(kept[0].severity, 'P2');
});

test('keeps genuine findings untouched', () => {
  const findings = [
    f({ severity: 'P1', message: 'SQL injection: user input concatenated into query.' }),
    f({ severity: 'P2', message: 'Missing await causes the transaction to commit before the write.' }),
  ];
  const { kept, dropped } = dropSelfNegatingFindings(findings);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 2);
});
