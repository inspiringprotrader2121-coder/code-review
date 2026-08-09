import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluationContextLimits } from './context.js';

test('evaluation context defaults match the production review runtime contract', () => {
  assert.deepEqual(evaluationContextLimits({}), {
    maxFileBytes: 300_000,
    maxFiles: 150,
    maxSourceFiles: 40,
    maxRelated: 12,
    maxDependents: 8,
    maxContextFileBytes: 120_000,
  });
  assert.equal(evaluationContextLimits({}).maxSourceFiles, 40);
  assert.equal(evaluationContextLimits({}).maxContextFileBytes, 120_000);
});

test('evaluation context limits retain production configuration overrides', () => {
  const env = {
    MAX_FILE_BYTES: '123456',
    MAX_FILES: '17',
    ORVEX_CTX_SOURCE: '9',
    ORVEX_CTX_RELATED: '7',
    ORVEX_CTX_DEPENDENTS: '6',
    ORVEX_CTX_FILE_BYTES: '54321',
  };
  assert.deepEqual(evaluationContextLimits(env), {
    maxFileBytes: 123456,
    maxFiles: 17,
    maxSourceFiles: 9,
    maxRelated: 7,
    maxDependents: 6,
    maxContextFileBytes: 54321,
  });
});

test('evaluation context accepts production zero-value context limits', () => {
  assert.deepEqual(evaluationContextLimits({ ORVEX_CTX_SOURCE: '0', ORVEX_CTX_FILE_BYTES: '0' }), {
    maxFileBytes: 300_000,
    maxFiles: 150,
    maxSourceFiles: 0,
    maxRelated: 12,
    maxDependents: 8,
    maxContextFileBytes: 0,
  });
});
