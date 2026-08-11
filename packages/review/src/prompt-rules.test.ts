import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOrvexRules, REQUIRED_RULE_ANCHORS } from './prompt.js';
import { DEFAULT_RULES, FOCUSED_DIFF_RULES } from './prompt/rules.js';

// Guard against the "edited the wrong file" bug (Codex, 2026-07-16): hunting and
// severity rules were added to the DEFAULT_RULES fallback in prompt.ts, but
// production loads rules/orvex-rules.md — so the rules were never active. These
// tests assert every required calibration anchor is present in BOTH the loaded
// production rules AND the fallback, so the two can never silently diverge again.

test('the LOADED production rules (loadOrvexRules) contain every required anchor', () => {
  const rules = loadOrvexRules();
  // In a normal checkout this reads rules/orvex-rules.md — the exact text prod uses.
  assert.ok(rules.length > 2000, 'loaded rules look truncated/empty');
  for (const re of REQUIRED_RULE_ANCHORS) {
    assert.match(rules, re, `production rules are MISSING required anchor: ${re}`);
  }
});

test('the DEFAULT_RULES fallback is never weaker than production (same anchors)', () => {
  for (const re of REQUIRED_RULE_ANCHORS) {
    assert.match(DEFAULT_RULES, re, `DEFAULT_RULES fallback is MISSING required anchor: ${re}`);
  }
});

test('focused diff policy stays compact while retaining evidence and severity discipline', () => {
  const rules = loadOrvexRules('focused');
  assert.equal(rules, FOCUSED_DIFF_RULES);
  assert.ok(rules.length < 2_000);
  assert.match(rules, /untrusted data/i);
  assert.match(rules, /concrete failure scenario/i);
  assert.match(rules, /P1 requires/i);
  assert.match(rules, /complete lifecycle/i);
  assert.match(rules, /legitimate large input is P2/i);
  assert.match(rules, /strict JSON/i);
});
