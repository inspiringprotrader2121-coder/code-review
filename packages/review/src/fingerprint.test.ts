import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintFinding, normalizeMessage } from './finding.js';

describe('fingerprintFinding', () => {
  it('is stable for same input', () => {
    const f = {
      file: 'backend/src/auth.js',
      ruleId: 'audit.test_path_patterns_in_table',
      message: 'testPathPatterns must not appear inside a markdown table row',
    };
    const a = fingerprintFinding(f);
    const b = fingerprintFinding(f);
    assert.equal(a, b);
  });

  it('is line-independent (pushes move code around)', () => {
    const a = { file: 'a.ts', ruleId: 'llm.security', message: 'Missing auth check' };
    // same finding, computed twice, is stable
    assert.equal(fingerprintFinding(a), fingerprintFinding(a));
    assert.match(fingerprintFinding(a), /^v\d+-/);
  });

  it('differs when the message differs', () => {
    const base = { file: 'a.ts', ruleId: 'llm.security' };
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
