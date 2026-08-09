import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransitionJob, type QueueJobState } from './state-machine.js';

test('golden queue transition matrix admits only documented durable lifecycles', () => {
  const expected: Record<QueueJobState, readonly QueueJobState[]> = {
    submitted: ['ready', 'cancelled'],
    ready: ['claimed', 'cancelled'],
    claimed: ['running', 'ready', 'cancelled', 'dead-lettered'],
    running: ['succeeded', 'failed', 'cancelled', 'dead-lettered'],
    succeeded: [],
    failed: ['ready', 'dead-lettered'],
    cancelled: [],
    'dead-lettered': ['ready'],
  };
  const states = Object.keys(expected) as QueueJobState[];
  for (const from of states) {
    for (const to of states) {
      assert.equal(canTransitionJob(from, to), expected[from].includes(to), `${from} -> ${to}`);
    }
  }
});
