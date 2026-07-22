import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOrvexRules, REQUIRED_RULE_ANCHORS } from './prompt.js';

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

test('the DEFAULT_RULES fallback is never weaker than production (same anchors)', async () => {
  // Re-read prompt.ts source and confirm the fallback string also carries every
  // anchor, so a future edit to only one source is caught immediately.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('./prompt.ts', import.meta.url)), 'utf8');
  const start = src.indexOf('const DEFAULT_RULES = `');
  const end = src.indexOf('`;', start);
  assert.ok(start >= 0 && end > start, 'could not locate DEFAULT_RULES literal');
  const fallback = src.slice(start, end);
  for (const re of REQUIRED_RULE_ANCHORS) {
    assert.match(fallback, re, `DEFAULT_RULES fallback is MISSING required anchor: ${re}`);
  }
});
