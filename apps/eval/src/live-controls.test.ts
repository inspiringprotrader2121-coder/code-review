import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EvaluationRequestBudget,
  requireLiveCaseLimit,
  requireLiveEvaluationControls,
} from './live-controls.js';

test('live evaluation requires explicit budget and request controls', () => {
  assert.throws(() => requireLiveEvaluationControls({}), /ORVEX_EVAL_LIVE/);
  assert.throws(
    () => requireLiveEvaluationControls({ ORVEX_EVAL_LIVE: '1' }),
    /ORVEX_EVAL_BUDGET_USD/,
  );
  assert.throws(
    () => requireLiveEvaluationControls({ ORVEX_EVAL_LIVE: '1', ORVEX_EVAL_BUDGET_USD: '5' }),
    /ORVEX_EVAL_MAX_REQUESTS/,
  );
  assert.throws(
    () =>
      requireLiveEvaluationControls({
        ORVEX_EVAL_LIVE: '1',
        ORVEX_EVAL_BUDGET_USD: '5',
        ORVEX_EVAL_MAX_REQUESTS: '3',
      }),
    /ORVEX_EVAL_RESULT_FILE/,
  );
  assert.deepEqual(
    requireLiveEvaluationControls({
      ORVEX_EVAL_LIVE: '1',
      ORVEX_EVAL_BUDGET_USD: '5.25',
      ORVEX_EVAL_MAX_REQUESTS: '3',
      ORVEX_EVAL_RESULT_FILE: '/tmp/eval.json',
    }),
    { declaredBudgetUsd: 5.25, maxRequests: 3, resultFile: '/tmp/eval.json' },
  );
  assert.throws(
    () =>
      requireLiveEvaluationControls({
        ORVEX_EVAL_LIVE: '1',
        ORVEX_EVAL_BUDGET_USD: '5',
        ORVEX_EVAL_MAX_REQUESTS: '3',
        ORVEX_EVAL_RESULT_FILE: 'relative-result.json',
      }),
    /absolute path/,
  );
});

test('the request budget refuses provider calls after the approved ceiling', () => {
  const budget = new EvaluationRequestBudget({
    declaredBudgetUsd: 1,
    maxRequests: 2,
    resultFile: '/tmp/eval.json',
  });
  budget.reserve('first');
  budget.reserve('second');
  assert.equal(budget.usedRequests, 2);
  assert.deepEqual(budget.operations, ['first', 'second']);
  assert.throws(() => budget.reserve('third'), /request ceiling reached/);
});

test('the selected corpus slice cannot exceed the declared live case ceiling', () => {
  assert.equal(requireLiveCaseLimit(2, { ORVEX_EVAL_MAX_CASES: '2' }), 2);
  assert.throws(() => requireLiveCaseLimit(3, { ORVEX_EVAL_MAX_CASES: '2' }), /selected 3 cases/);
  assert.throws(
    () => requireLiveCaseLimit(0, { ORVEX_EVAL_MAX_CASES: '2' }),
    /at least one whole case/,
  );
});
