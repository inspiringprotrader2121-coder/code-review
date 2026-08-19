import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountUsage,
  createUsageCostPolicy,
  DEEPSEEK_PEAK_OFFPEAK_EFFECTIVE_MS,
  isDeepSeekPeakUtc,
  publishedDeepSeekRates,
} from './usage-accounting.js';
import type { LlmTarget } from './worker-types.js';

const flashTarget: LlmTarget = {
  apiKey: 'deepseek-key',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  api: 'responses',
  transport: 'responses',
  admissionBucket: 'deepseek',
  thinking: true,
};

const proTarget: LlmTarget = {
  ...flashTarget,
  model: 'deepseek-v4-pro',
  api: 'chat',
  transport: 'compatible-chat',
};

const flashTokens = {
  inputTokens: 1_000_000,
  cachedInputTokens: 900_000,
  outputTokens: 1_000_000,
};

test('DeepSeek peak windows match the published UTC hours', () => {
  assert.equal(isDeepSeekPeakUtc(new Date('2026-08-17T00:59:59Z')), false);
  assert.equal(isDeepSeekPeakUtc(new Date('2026-08-17T01:00:00Z')), true);
  assert.equal(isDeepSeekPeakUtc(new Date('2026-08-17T03:59:59Z')), true);
  assert.equal(isDeepSeekPeakUtc(new Date('2026-08-17T04:00:00Z')), false);
  assert.equal(isDeepSeekPeakUtc(new Date('2026-08-17T05:59:59Z')), false);
  assert.equal(isDeepSeekPeakUtc(new Date('2026-08-17T06:00:00Z')), true);
  assert.equal(isDeepSeekPeakUtc(new Date('2026-08-17T09:59:59Z')), true);
  assert.equal(isDeepSeekPeakUtc(new Date('2026-08-17T10:00:00Z')), false);
});

test('DeepSeek keeps the flat card until 16:00 UTC on 16 Aug 2026', () => {
  const justBefore = new Date(DEEPSEEK_PEAK_OFFPEAK_EFFECTIVE_MS - 1);
  assert.deepEqual(publishedDeepSeekRates('flash', justBefore), {
    input: 0.14,
    cachedInput: 0.0028,
    cacheWrite: 0.14,
    output: 0.28,
  });
  assert.deepEqual(publishedDeepSeekRates('pro', justBefore), {
    input: 0.435,
    cachedInput: 0.003625,
    cacheWrite: 0.435,
    output: 0.87,
  });
});

test('DeepSeek switches to off-peak at the published effective instant', () => {
  const start = new Date(DEEPSEEK_PEAK_OFFPEAK_EFFECTIVE_MS);
  assert.equal(start.toISOString(), '2026-08-16T16:00:00.000Z');
  assert.deepEqual(publishedDeepSeekRates('flash', start), {
    input: 0.22,
    cachedInput: 0.007,
    cacheWrite: 0.22,
    output: 0.66,
  });
  assert.deepEqual(publishedDeepSeekRates('pro', start), {
    input: 0.66,
    cachedInput: 0.022,
    cacheWrite: 0.66,
    output: 1.98,
  });
});

test('usage accounting bills Flash peak and off-peak from the official card', () => {
  const offPeak = accountUsage(
    'deepseek-flash',
    flashTarget,
    'verification',
    flashTokens,
    createUsageCostPolicy({}),
    new Date('2026-08-17T12:00:00Z'),
  );
  assert.equal(offPeak.inputRatePerM, 0.22);
  assert.equal(offPeak.cachedInputRatePerM, 0.007);
  assert.equal(offPeak.outputRatePerM, 0.66);
  assert.equal(offPeak.costUsd, 0.6883);

  const peak = accountUsage(
    'deepseek-flash',
    flashTarget,
    'verification',
    flashTokens,
    createUsageCostPolicy({}),
    new Date('2026-08-17T07:00:00Z'),
  );
  assert.equal(peak.inputRatePerM, 0.44);
  assert.equal(peak.cachedInputRatePerM, 0.014);
  assert.equal(peak.outputRatePerM, 1.32);
  assert.equal(peak.costUsd, 1.3766);
});

test('usage accounting bills Pro peak and off-peak from the official card', () => {
  const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const offPeak = accountUsage(
    'deepseek',
    proTarget,
    'discovery',
    tokens,
    createUsageCostPolicy({}),
    new Date('2026-08-17T12:00:00Z'),
  );
  assert.equal(offPeak.inputRatePerM, 0.66);
  assert.equal(offPeak.outputRatePerM, 1.98);
  assert.equal(offPeak.costUsd, 2.64);

  const peak = accountUsage(
    'deepseek',
    proTarget,
    'discovery',
    tokens,
    createUsageCostPolicy({}),
    new Date('2026-08-17T02:00:00Z'),
  );
  assert.equal(peak.inputRatePerM, 1.32);
  assert.equal(peak.outputRatePerM, 3.96);
  assert.equal(peak.costUsd, 5.28);
});

test('stale DeepSeek env rates cannot understate a billed call', () => {
  const stale = createUsageCostPolicy({
    'deepseek-flash': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
    modelRates: {
      'deepseek-v4-flash': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
    },
  });
  const billed = accountUsage(
    'deepseek-flash',
    flashTarget,
    'verification',
    flashTokens,
    stale,
    new Date('2026-08-17T12:00:00Z'),
  );
  assert.equal(billed.outputRatePerM, 0.66);
  assert.equal(billed.costUsd, 0.6883);
});
