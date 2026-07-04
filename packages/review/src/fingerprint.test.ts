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

  it('is stable when only the line shifts (pushes move code around)', () => {
    const base = {
      file: 'a.ts',
      ruleId: 'llm.security',
      message: 'Missing auth check',
    };
    assert.equal(
      fingerprintFinding({ ...base, line: 1 }),
      fingerprintFinding({ ...base, line: 2 }),
    );
  });

  it('differs when the message differs', () => {
    const base = { file: 'a.ts', line: 1, ruleId: 'llm.security' };
    assert.notEqual(
      fingerprintFinding({ ...base, message: 'Missing auth check' }),
      fingerprintFinding({ ...base, message: 'SQL injection in query builder' }),
    );
  });

  it('normalizes message casing', () => {
    assert.equal(
      normalizeMessage('Hello  World!'),
      normalizeMessage('hello world'),
    );
  });
});
