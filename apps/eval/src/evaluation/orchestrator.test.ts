import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runControlledEvaluation } from './orchestrator.js';

test('controlled evaluation refuses to select a corpus or create a provider request without live opt-in', async () => {
  await assert.rejects(
    () => runControlledEvaluation(undefined, {}, { log: () => undefined }),
    /live evaluation is disabled/,
  );
});
