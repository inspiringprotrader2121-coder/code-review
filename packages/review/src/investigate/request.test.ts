import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvestigateGeneration, investigateOutputContract } from './request.js';
import type { AgenticGenerateRequest } from '../agentic/types.js';

test('normal and semantic-repair investigate contracts are identical', () => {
  const normal = investigateOutputContract('responses', false);
  const repair = investigateOutputContract('responses', false);
  assert.deepEqual(normal, repair);
  assert.equal(normal.schemaName, 'orvex_investigate_turn');
  assert.equal(normal.schemaEnforced, true);
  assert.equal(normal.toolsEnabled, true);
  assert.equal(normal.toolChoice, 'tool_or_final');
  assert.equal(normal.jsonContractPrefix, '');
});

test('forceDone investigate contract is final-only for normal and repair', () => {
  const normal = investigateOutputContract('responses', true);
  const repair = investigateOutputContract('responses', true);
  assert.deepEqual(normal, repair);
  assert.equal(normal.schemaName, 'orvex_investigate_final');
  assert.equal(normal.toolsEnabled, false);
  assert.equal(normal.toolChoice, 'final_only');
});

test('buildInvestigateGeneration shares schema, tokens, and tools across modes', () => {
  const transcript = ['Investigate a.ts'];
  const normalRequest: AgenticGenerateRequest = {
    turn: 0,
    lastTurn: false,
    source: 'normal',
    previousText: '',
    thinking: false,
    repairAttempt: 0,
  };
  const repairRequest: AgenticGenerateRequest = {
    turn: 0,
    lastTurn: false,
    source: 'recovery',
    previousText: 'completed non-JSON',
    previousKind: 'malformed',
    thinking: false,
    repairAttempt: 2,
  };
  const normal = buildInvestigateGeneration({
    request: normalRequest,
    transcript,
    api: 'responses',
    maxTokens: 28_000,
  });
  const repair = buildInvestigateGeneration({
    request: repairRequest,
    transcript,
    api: 'responses',
    maxTokens: 28_000,
  });
  assert.deepEqual(normal.contract, repair.contract);
  assert.equal(normal.maxTokens, repair.maxTokens);
  assert.equal(normal.thinking, repair.thinking);
  assert.equal(repair.sourceLabel, 'repair_2');
  assert.match(repair.user, /FORMAT REPAIR #2/);
  assert.match(repair.user, /request another tool/);
  assert.doesNotMatch(repair.user, /No more tools|FINAL TURN/);
  assert.doesNotMatch(repair.user, /Complete the JSON object now/);
});
