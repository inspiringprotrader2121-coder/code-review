import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAuditDocIssues,
  hasTestPathPatternsInTableRow,
  auditFindingsFromContent,
} from './doc-audit.js';

describe('doc-audit', () => {
  it('detects testPathPatterns in table row', () => {
    const md = '| cmd | testPathPatterns=\'npm test\' |';
    assert.equal(hasTestPathPatternsInTableRow(md), true);
    assert.ok(getAuditDocIssues(md, 'docs/audit/slice-01.md').includes('test_path_patterns_in_table'));
  });

  it('passes clean fenced block pattern', () => {
    const md = '```bash\ntestPathPatterns=\'npm test\'\n```';
    assert.equal(hasTestPathPatternsInTableRow(md), false);
  });

  it('emits findings with rule ids', () => {
    const findings = auditFindingsFromContent(
      '| x | testPathPatterns=foo |',
      'audit.md',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, 'audit.test_path_patterns_in_table');
    assert.equal(findings[0].confidence, 1);
  });
});
