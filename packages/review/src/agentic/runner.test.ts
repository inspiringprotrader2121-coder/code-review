import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonContractMismatchError } from '../llm-client.js';
import { runAgenticReviewLoop } from './runner.js';
import { agenticRecoveryInstruction } from './recovery.js';
import { classifyAgenticProviderFailure } from './errors.js';
import { classifyAgenticTurn } from '../investigate/classify.js';
import type { AgenticGenerateRequest, AgenticLoopFailure, AgenticTurnLog } from './types.js';
import type { InvestigateToolStep } from '../investigate/classify.js';
import type { LlmReviewResponse } from '../types.js';

const tool = (path: string): string =>
  JSON.stringify({
    action: 'tool',
    tool: { name: 'read_file', path },
    reason: 'inspect',
  });

const finalReview = (summary: string, findings: unknown[] = []): string =>
  JSON.stringify({ action: 'final', findings, summary });

const emptyFinal = finalReview('No actionable issues.');
const malformed = JSON.stringify({
  action: 'done',
  findings: [{ file: 'a.ts', severity: 'P2' }],
  summary: 'schema mismatch',
});

type LoopResult =
  | { ok: true; value: LlmReviewResponse; reason?: undefined }
  | { ok: false; value?: undefined; reason: AgenticLoopFailure['reason'] };

async function runScript(
  replies: Array<string | Error>,
  extras: {
    maxTurns?: number;
    lastTurnForcesFinal?: boolean;
    maxTotalRepairAttempts?: number;
    maxSemanticRepairsPerTurn?: number;
    isTransientError?: (error: unknown) => boolean;
  } = {},
): Promise<{
  result: LoopResult;
  tools: InvestigateToolStep[];
  requests: AgenticGenerateRequest[];
  logs: AgenticTurnLog[];
}> {
  const tools: InvestigateToolStep[] = [];
  const requests: AgenticGenerateRequest[] = [];
  const logs: AgenticTurnLog[] = [];
  let index = 0;
  const result = await runAgenticReviewLoop<InvestigateToolStep, LlmReviewResponse, LoopResult>({
    maxTurns: extras.maxTurns ?? 6,
    lastTurnForcesFinal: extras.lastTurnForcesFinal ?? false,
    maxTotalRepairAttempts: extras.maxTotalRepairAttempts,
    maxSemanticRepairsPerTurn: extras.maxSemanticRepairsPerTurn,
    classify: classifyAgenticTurn,
    generate: async (request) => {
      requests.push(request);
      const next = replies[index++];
      if (next instanceof Error) throw next;
      if (typeof next !== 'string') throw new Error('script exhausted');
      return next;
    },
    executeTool: async (step) => {
      tools.push(step);
    },
    onFinal: (value) => ({ ok: true, value }),
    onFailure: (failure) => ({ ok: false, reason: failure.reason }),
    log: (entry) => logs.push(entry),
    isTransientError: extras.isTransientError,
  });
  return { result, tools, requests, logs };
}

test('agentic recovery instruction allows tools unless it is the last turn', () => {
  assert.match(agenticRecoveryInstruction(false), /request another tool/);
  assert.doesNotMatch(agenticRecoveryInstruction(false), /No more tools/);
  assert.match(agenticRecoveryInstruction(true), /No more tools/);
  assert.match(agenticRecoveryInstruction(true, 'last_turn_tool'), /valid tool call/);
  assert.doesNotMatch(agenticRecoveryInstruction(true, 'last_turn_tool'), /malformed JSON/);
  assert.match(agenticRecoveryInstruction(false, 'malformed', 2), /FORMAT REPAIR #2/);
  assert.match(agenticRecoveryInstruction(false, 'malformed', 2), /request another tool/);
});

test('classifyAgenticProviderFailure distinguishes timeout and rate limit', () => {
  assert.equal(
    classifyAgenticProviderFailure(new Error('LLM request stalled (no data for 30000ms)')),
    'timeout',
  );
  assert.equal(
    classifyAgenticProviderFailure(new Error('LLM request failed (429): rate limited')),
    'rate_limit',
  );
});

test('shared runner: immediate final succeeds', async () => {
  const { result, tools, requests } = await runScript([emptyFinal]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.findings, []);
  assert.equal(tools.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.source, 'normal');
});

test('shared runner: immediate empty final is successful coverage', async () => {
  const { result } = await runScript([
    '{"action":"final","findings":[],"summary":"No actionable issues."}',
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.findings, []);
    assert.equal(result.value.summary, 'No actionable issues.');
  }
});

test('shared runner: one tool then final succeeds', async () => {
  const { result, tools } = await runScript([tool('a.ts'), emptyFinal]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    tools.map((step) => step.tool.path),
    ['a.ts'],
  );
});

test('shared runner: multiple tools then final succeeds', async () => {
  const { result, tools } = await runScript([tool('a.ts'), tool('b.ts'), emptyFinal]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    tools.map((step) => step.tool.path),
    ['a.ts', 'b.ts'],
  );
});

test('shared runner: malformed first turn recovers to final', async () => {
  const { result, requests, logs } = await runScript([malformed, emptyFinal]);
  assert.equal(result.ok, true);
  assert.equal(requests[1]?.source, 'recovery');
  assert.equal(requests[1]?.lastTurn, false);
  assert.ok(logs.some((entry) => entry.kind === 'recovery_final' && entry.accepted === true));
});

test('shared runner: malformed first turn recovers to a tool then final', async () => {
  const { result, tools, requests } = await runScript([malformed, tool('a.ts'), emptyFinal]);
  assert.equal(result.ok, true);
  assert.equal(requests[1]?.source, 'recovery');
  assert.deepEqual(
    tools.map((step) => step.tool.path),
    ['a.ts'],
  );
});

test('shared runner: post-tool malformed recovers to final', async () => {
  const { result, tools } = await runScript([tool('a.ts'), malformed, emptyFinal]);
  assert.equal(result.ok, true);
  assert.equal(tools.length, 1);
});

test('shared runner #315: tool then malformed then recovery tool then final', async () => {
  const { result, tools, requests, logs } = await runScript([
    tool('auth/a.ts'),
    malformed,
    tool('auth/b.ts'),
    emptyFinal,
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    tools.map((step) => step.tool.path),
    ['auth/a.ts', 'auth/b.ts'],
  );
  assert.equal(requests[2]?.source, 'recovery');
  assert.equal(requests[2]?.lastTurn, false);
  const recoveryTool = logs.find((entry) => entry.kind === 'recovery_tool');
  assert.equal(recoveryTool?.accepted, true);
  assert.equal(recoveryTool?.reenteredAgentLoop, true);
  assert.ok(logs.some((entry) => entry.kind === 'normal_final' && entry.accepted === true));
});

test('shared runner: multiple tools after repair re-enter the agent loop', async () => {
  const { result, tools, requests } = await runScript([
    tool('a.ts'),
    malformed,
    tool('b.ts'),
    tool('c.ts'),
    emptyFinal,
  ]);
  assert.equal(result.ok, true);
  assert.equal(requests[2]?.source, 'recovery');
  assert.deepEqual(
    tools.map((step) => step.tool.path),
    ['a.ts', 'b.ts', 'c.ts'],
  );
});

test('shared runner: empty final after repair succeeds', async () => {
  const { result } = await runScript([tool('a.ts'), malformed, emptyFinal]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.findings, []);
});

test('shared runner: repeated malformed output is a bounded parse failure', async () => {
  const { result, requests } = await runScript([malformed, malformed, malformed, malformed], {
    maxTurns: 4,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'parse_failure');
  assert.equal(requests.length, 3, 'one normal miss plus two bounded recoveries, no infinite loop');
  assert.equal(requests[1]?.repairAttempt, 1);
  assert.equal(requests[2]?.repairAttempt, 2);
  assert.equal(requests[1]?.source, 'recovery');
  assert.equal(requests[2]?.source, 'recovery');
});

test('shared runner: tool-loop exhaustion is an explicit failure', async () => {
  const { result, tools } = await runScript([tool('a.ts'), tool('b.ts'), tool('c.ts')], {
    maxTurns: 3,
    lastTurnForcesFinal: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'tool_loop_exhaustion');
  assert.equal(tools.length, 3);
});

test('shared runner: provider timeout is classified and propagated', async () => {
  const timeout = new Error('LLM request stalled (no data for 30000ms)');
  await assert.rejects(
    () => runScript([timeout]),
    (error: unknown) => error instanceof Error && /stalled/i.test(error.message),
  );
});

test('shared runner: rate limit is classified and propagated', async () => {
  const rateLimit = new Error('LLM request failed (429): rate limited');
  await assert.rejects(
    () => runScript([rateLimit]),
    (error: unknown) => error instanceof Error && /429|rate/i.test(error.message),
  );
});

test('shared runner: complete-but-invalid JSON recovers without a guessed prefix', async () => {
  const mismatch = new JsonContractMismatchError(malformed);
  const { result, requests } = await runScript([mismatch, emptyFinal]);
  assert.equal(result.ok, true);
  assert.equal(requests[1]?.source, 'recovery');
  assert.equal(requests[1]?.previousText, malformed);
  assert.doesNotMatch(JSON.stringify(requests), /\{\\"step\\":\{\\"action\\":/);
});

test('shared runner last-turn budget applies equally to normal and recovery', async () => {
  const { result, tools, requests } = await runScript([tool('a.ts'), malformed, emptyFinal], {
    maxTurns: 2,
    lastTurnForcesFinal: true,
  });
  assert.equal(result.ok, true);
  assert.equal(tools.length, 1, 'last-turn recovery must not execute a tool');
  assert.equal(requests[1]?.lastTurn, true);
  assert.equal(requests[2]?.lastTurn, true);
  assert.equal(requests[2]?.source, 'recovery');
});

test('shared runner: recovery provider errors are not labeled parse_failure', async () => {
  const { result, logs } = await runScript(
    [malformed, new Error('LLM request failed (503): provider unavailable')],
    { isTransientError: () => false },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'provider_error');
  assert.ok(
    logs.some((entry) => entry.source === 'recovery' && entry.finishReason === 'provider_error'),
  );
});

test('shared runner: last-turn forced-final provider errors are logged', async () => {
  const { result, logs, requests } = await runScript(
    [tool('a.ts'), new Error('LLM request failed (503): provider unavailable')],
    { maxTurns: 1, lastTurnForcesFinal: true, isTransientError: () => false },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'provider_error');
  assert.equal(requests[1]?.previousKind, 'last_turn_tool');
  assert.ok(
    logs.some(
      (entry) =>
        entry.source === 'recovery' &&
        entry.finishReason === 'provider_error' &&
        entry.lastTurnForcesFinal === true,
    ),
  );
});

test('shared runner: last-turn tool then recovery still tool is explicit failure', async () => {
  const { result, tools, requests, logs } = await runScript([tool('a.ts'), tool('b.ts')], {
    maxTurns: 1,
    lastTurnForcesFinal: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'tool_loop_exhaustion');
  assert.equal(tools.length, 0, 'forceDone must not execute a tool');
  assert.equal(requests[1]?.lastTurn, true);
  assert.equal(requests[1]?.previousKind, 'last_turn_tool');
  assert.equal(requests[1]?.repairAttempt, 1);
  assert.ok(logs.some((entry) => entry.lastTurnForcesFinal === true && entry.accepted === false));
});

test('shared runner #303: two completed invalid replies then repair #2 final', async () => {
  const { result, requests, logs } = await runScript([malformed, malformed, emptyFinal]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.findings, []);
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.source, 'recovery');
  assert.equal(requests[1]?.repairAttempt, 1);
  assert.equal(requests[2]?.source, 'recovery');
  assert.equal(requests[2]?.repairAttempt, 2);
  assert.equal(requests[2]?.thinking, false);
  assert.ok(
    logs.some((entry) => entry.sourceLabel === 'repair_2' && entry.kind === 'recovery_final'),
  );
});

test('shared runner #303: two completed invalid replies then repair #2 tool then final', async () => {
  const { result, tools, requests, logs } = await runScript([
    malformed,
    malformed,
    tool('recovered.ts'),
    emptyFinal,
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    tools.map((step) => step.tool.path),
    ['recovered.ts'],
  );
  assert.equal(requests[2]?.source, 'recovery');
  assert.equal(requests[2]?.repairAttempt, 2);
  assert.equal(requests[3]?.source, 'normal');
  const recoveryTool = logs.find((entry) => entry.kind === 'recovery_tool');
  assert.equal(recoveryTool?.repairAttempt, 2);
  assert.equal(recoveryTool?.reenteredAgentLoop, true);
  assert.ok(logs.some((entry) => entry.kind === 'normal_final' && entry.accepted === true));
});

test('shared runner: JsonContractMismatchError still gets a second fresh repair', async () => {
  const mismatch = new JsonContractMismatchError('this is not json at all');
  const { result, requests } = await runScript([mismatch, mismatch, emptyFinal]);
  assert.equal(result.ok, true);
  assert.equal(requests[1]?.source, 'recovery');
  assert.equal(requests[2]?.source, 'recovery');
  assert.equal(requests[2]?.repairAttempt, 2);
  assert.doesNotMatch(JSON.stringify(requests), /\{\\"step\\":\{\\"action\\":/);
});

test('shared runner: two-turn repair budget stays finite after a recovered tool', async () => {
  const { result, requests } = await runScript(
    [malformed, malformed, tool('a.ts'), malformed, malformed, malformed],
    { maxTurns: 6, maxTotalRepairAttempts: 3 },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reason === 'parse_failure' || result.reason === 'repair_budget_exhausted');
  }
  assert.ok(requests.length <= 6);
  const repairs = requests.filter((request) => request.source === 'recovery');
  assert.ok(repairs.length <= 3);
});

test('shared runner: exhausted recovery budget is repair_budget_exhausted', async () => {
  const { result, requests, logs } = await runScript([malformed], {
    maxTotalRepairAttempts: 0,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'repair_budget_exhausted');
  assert.equal(requests.length, 1, 'budget miss must not pay for a recovery generation');
  assert.ok(logs.some((entry) => entry.finishReason === 'repair_budget_exhausted'));
});
