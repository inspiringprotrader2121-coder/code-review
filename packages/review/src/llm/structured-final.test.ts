import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonContractMismatchError } from './parsing.js';
import { recoverStructuredFinal, wrapStructuredFinalRepairUser } from './structured-final.js';

test('recoverStructuredFinal accepts a valid final with no repair', async () => {
  let calls = 0;
  const result = await recoverStructuredFinal({
    stage: 'review',
    generate: async () => {
      calls++;
      return '{"findings":[],"summary":"ok"}';
    },
    parse: (text) => JSON.parse(text) as { findings: unknown[] },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.findings, []);
});

test('recoverStructuredFinal uses a fresh repair for complete non-JSON, not the previous text', async () => {
  const users: string[] = [];
  const result = await recoverStructuredFinal({
    stage: 'review',
    generate: async ({ source, previousText, repairAttempt }) => {
      users.push(
        source === 'recovery' ? wrapStructuredFinalRepairUser('base', previousText) : 'base',
      );
      if (repairAttempt === 0) {
        throw new JsonContractMismatchError('This change looks safe...', {
          failureClass: 'complete_non_json',
          recoveryMode: 'fresh_semantic_repair',
          parseResult: 'invalid',
          stopReason: 'end_turn',
        });
      }
      return '{"findings":[],"summary":"No actionable issues found."}';
    },
    parse: (text) => JSON.parse(text) as { findings: unknown[]; summary: string },
  });
  assert.equal(users.length, 2);
  assert.equal(users[0], 'base');
  assert.match(users[1] ?? '', /did not satisfy the required review JSON schema/i);
  assert.doesNotMatch(users[1] ?? '', /Complete the JSON object now/);
  assert.deepEqual(result.findings, []);
});

test('recoverStructuredFinal fails closed after bounded repairs stay malformed', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      recoverStructuredFinal({
        stage: 'review',
        maxRepairAttempts: 2,
        generate: async () => {
          calls++;
          throw new JsonContractMismatchError('still prose');
        },
        parse: () => {
          throw new Error('unreachable');
        },
      }),
    /JSON contract mismatch/,
  );
  assert.equal(calls, 3, 'primary plus two bounded repairs');
});
