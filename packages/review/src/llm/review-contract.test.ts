import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonContractMismatchError } from './parsing.js';
import {
  coverageFailureFromError,
  summaryClaimsIssues,
  summaryConcludesNoIssues,
} from './review-contract.js';

test('empty findings plus a no-issues summary is a legitimate completed pass', () => {
  assert.equal(summaryConcludesNoIssues('No actionable issues'), true);
  assert.equal(summaryConcludesNoIssues('No actionable issues found.'), true);
  assert.equal(summaryClaimsIssues('No actionable issues found.'), false);
});

test('placeholder findings are not treated as a no-issues conclusion', () => {
  assert.equal(summaryConcludesNoIssues(undefined), false);
  assert.equal(summaryClaimsIssues('Found 1 P1 SQL injection in auth.ts'), true);
  assert.equal(summaryClaimsIssues('Reviewed the supplied diff.'), false);
});

test('coverageFailure distinguishes unusable JSON from no parseable object', () => {
  assert.equal(
    coverageFailureFromError(new Error('LLM response contained no parseable JSON')),
    'no_parseable_review_json',
  );
  assert.equal(
    coverageFailureFromError(new Error('LLM review JSON had no usable findings')),
    'all_findings_unusable',
  );
  assert.equal(
    coverageFailureFromError(new Error('LLM review JSON was missing findings/issues')),
    'invalid_review_contract',
  );
  assert.equal(
    coverageFailureFromError(
      new JsonContractMismatchError('This looks safe.', {
        failureClass: 'complete_non_json',
        parseResult: 'invalid',
        recoveryMode: 'fresh_semantic_repair',
        stopReason: 'end_turn',
      }),
    ),
    'no_parseable_review_json',
  );
});
