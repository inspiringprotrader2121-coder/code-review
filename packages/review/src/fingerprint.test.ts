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

  it('includes category in the stem so same-message different categories differ', () => {
    const base = { file: 'a.ts', ruleId: 'llm.security', message: 'Missing auth check' };
    assert.notEqual(
      fingerprintFinding({ ...base, category: 'security' }),
      fingerprintFinding({ ...base, category: 'correctness' }),
    );
  });

  it('keeps a long message stem (beyond the old 80-char cut)', () => {
    const prefix = 'x'.repeat(90);
    const a = fingerprintFinding({ file: 'a.ts', ruleId: 'llm.x', message: `${prefix} alpha` });
    const b = fingerprintFinding({ file: 'a.ts', ruleId: 'llm.x', message: `${prefix} beta` });
    assert.notEqual(a, b);
  });
});
