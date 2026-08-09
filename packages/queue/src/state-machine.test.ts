import assert from 'node:assert/strict';
import test from 'node:test';
import { assertJobTransition, canTransitionJob } from './state-machine.js';

test('queue state machine permits the documented success lifecycle', () => {
  const states = ['submitted', 'ready', 'claimed', 'running', 'succeeded'] as const;
  for (let index = 1; index < states.length; index++) {
    assert.equal(canTransitionJob(states[index - 1]!, states[index]!), true);
  }
});

test('queue state machine requires explicit retry and dead-letter transitions', () => {
  assert.equal(canTransitionJob('running', 'ready'), false);
  assert.equal(canTransitionJob('failed', 'ready'), true);
  assert.equal(canTransitionJob('dead-lettered', 'ready'), true);
  assert.throws(() => assertJobTransition('succeeded', 'running'), /invalid queue transition/);
});
