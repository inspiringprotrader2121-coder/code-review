import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintFinding, normalizeMessage } from './finding.js';

describe('fingerprintFinding', () => {
  it('is stable for same input', () => {
    const f = {
      file: 'backend/src/auth.js',
      line: 42,
      ruleId: 'audit.test_path_patterns_in_table',
      message: 'testPathPatterns must not appear inside a markdown table row',
    };
    const a = fingerprintFinding(f);
    const b = fingerprintFinding(f);
    assert.equal(a, b);
  });

  it('differs when line changes', () => {
    const base = {
      file: 'a.ts',
      ruleId: 'llm.security',
      message: 'Missing auth check',
    };
    assert.notEqual(
      fingerprintFinding({ ...base, line: 1 }),
      fingerprintFinding({ ...base, line: 2 }),
    );
  });

  it('normalizes message casing', () => {
    assert.equal(
      normalizeMessage('Hello  World!'),
      normalizeMessage('hello world'),
    );
  });
});
