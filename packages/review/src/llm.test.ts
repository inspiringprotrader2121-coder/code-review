import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmReviewResponseSchema } from './types.js';
import { normalizeLlmResponse } from './llm.js';

test('normalizeLlmResponse maps MiniMax severity vocabulary to P-levels', () => {
  const raw = {
    findings: [
      { file: 'a.ts', line: 1, severity: 'critical', category: 'security', message: 'rce', confidence: 0.9 },
      { file: 'b.ts', line: 2, severity: 'high', category: 'bug', message: 'npe', confidence: 0.8 },
      { file: 'c.ts', line: 3, severity: 'medium', category: 'style', message: 'nit', confidence: 0.7 },
      { file: 'd.ts', severity: 'info', category: 'note', message: 'fyi', confidence: 0.6 },
    ],
  };
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(raw));
  assert.deepEqual(parsed.findings.map((f) => f.severity), ['P1', 'P2', 'P3', 'info']);
});

test('normalizeLlmResponse accepts alternate field names', () => {
  const raw = {
    issues: [
      { path: 'x.ts', line_number: 5, priority: 'blocker', type: 'security', description: 'bad', score: 0.95, fix: 'do this' },
    ],
  };
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(raw));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].file, 'x.ts');
  assert.equal(parsed.findings[0].line, 5);
  assert.equal(parsed.findings[0].severity, 'P1');
  assert.equal(parsed.findings[0].category, 'security');
  assert.equal(parsed.findings[0].message, 'bad');
  assert.equal(parsed.findings[0].suggestion, 'do this');
});

test('normalizeLlmResponse drops findings missing message or file', () => {
  const raw = {
    findings: [
      { file: 'a.ts', severity: 'high' }, // no message
      { message: 'orphan', severity: 'high' }, // no file
      { file: 'ok.ts', message: 'keep', severity: 'low', confidence: 0.5 },
    ],
  };
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(raw));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].file, 'ok.ts');
});

test('normalizeLlmResponse defaults unknown severity to info (fail toward nitpick) and clamps confidence', () => {
  const raw = { findings: [{ file: 'a.ts', message: 'm', severity: 'weird', confidence: 5 }] };
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(raw));
  // Unknown/unrecognized severity → info, NOT P3 (P3 now means MEDIUM = a real bug).
  assert.equal(parsed.findings[0].severity, 'info');
  assert.equal(parsed.findings[0].confidence, 1);
  assert.equal(parsed.findings[0].category, 'general');
});
