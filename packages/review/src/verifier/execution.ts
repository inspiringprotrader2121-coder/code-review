import { randomBytes } from 'node:crypto';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { extractJsonLoose, llmChat } from '../llm-client.js';
import type { ReviewFinding } from '../finding.js';
import {
  VerdictSchema,
  type VerifierOptions,
  type VerifiedFindings,
  type VerificationBatchResult,
} from './contracts.js';
import { buildVerifierPrompt } from './prompt.js';
import { applyVerdicts } from './verdicts.js';

const runtimeConfig = loadReviewRuntimeConfig();
const MAX_VERIFY_FILE_CHARS = runtimeConfig.verifyFileChars;
const MAX_VERIFY_TOTAL_CHARS = runtimeConfig.verifyTotalChars;
const MAX_FINDINGS_PER_BATCH = runtimeConfig.verifyBatchSize;

function chunkFindings<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
}

async function invokeVerifier(
  system: string,
  user: string,
  options: VerifierOptions,
): Promise<string> {
  if (options.runner && options.target) {
    return options.runner.run({
      system,
      user,
      target: options.target,
      json: true,
      signal: options.signal,
      onUsage: options.onUsage,
      onAttempt: options.onAttempt,
    });
  }
  try {
    return await llmChat(system, user, {
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl,
      api: options.api,
      reasoningEffort: options.reasoningEffort,
      maxTokens: options.maxTokens,
      signal: options.signal,
      json: true,
      onUsage: options.onUsage,
      onAttempt: options.onAttempt,
    });
  } catch (error) {
    console.warn('[verifier] call failed (no whole-call replay):', (error as Error).message);
    throw error;
  }
}

async function verifyFindingsBatch(
  findings: ReviewFinding[],
  files: Array<{ path: string; content: string }>,
  options: VerifierOptions & { maxFileChars: number; maxTotalChars: number },
): Promise<VerificationBatchResult> {
  const sentinel = `ORVEX_DATA_${randomBytes(9).toString('hex')}`;
  const prompt = buildVerifierPrompt(findings, files, sentinel, options);
  const text = await invokeVerifier(prompt.system, prompt.user, options);
  return applyVerdicts(
    findings,
    VerdictSchema.parse(extractJsonLoose(text)),
    options.confirmedCount ?? findings.length,
  );
}

export async function verifyFindings(
  findings: ReviewFinding[],
  files: Array<{ path: string; content: string }>,
  options: VerifierOptions,
): Promise<VerifiedFindings> {
  if (findings.length === 0)
    return { status: 'verified', kept: [], dropped: [], duplicates: [], unverified: [] };
  const batchSize = options.maxFindingsPerBatch ?? MAX_FINDINGS_PER_BATCH;
  const maxTotalChars = options.maxTotalChars ?? MAX_VERIFY_TOTAL_CHARS;
  const batches = chunkFindings(findings, batchSize);
  const kept: ReviewFinding[] = [];
  const dropped: Array<{ finding: ReviewFinding; reason: string }> = [];
  const duplicates: Array<{ finding: ReviewFinding; of: ReviewFinding }> = [];
  const unverified: ReviewFinding[] = [];
  let anyBatchOk = false;
  let anyBatchFailed = false;
  let lastError: string | undefined;
  const confirmedCeiling = options.confirmedCount ?? findings.length;
  const runBatch = async (batchIndex: number): Promise<void> => {
    const batch = batches[batchIndex]!;
    const globalStart = batchIndex * batchSize;
    const confirmedInBatch = batch.filter(
      (_, index) => globalStart + index < confirmedCeiling,
    ).length;
    try {
      const partial = await verifyFindingsBatch(batch, files, {
        ...options,
        confirmedCount: confirmedInBatch,
        maxTotalChars,
        maxFileChars: MAX_VERIFY_FILE_CHARS,
      });
      anyBatchOk = true;
      kept.push(...partial.kept);
      dropped.push(...partial.dropped);
      duplicates.push(...partial.duplicates);
      unverified.push(...partial.unverified);
    } catch (error) {
      anyBatchFailed = true;
      lastError = (error as Error).message;
      console.warn(
        `[verifier] batch failed; marking ${batch.length} finding(s) unverified:`,
        lastError,
      );
      unverified.push(...batch);
    }
  };
  let nextBatch = 0;
  const concurrency = loadReviewRuntimeConfig().verifyConcurrency;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      for (;;) {
        const batchIndex = nextBatch++;
        if (batchIndex >= batches.length) return;
        await runBatch(batchIndex);
      }
    }),
  );
  if (!anyBatchOk) {
    return {
      status: 'unavailable',
      unavailableReason: lastError ?? 'verification unavailable after retries',
      kept: [],
      dropped: [],
      duplicates: [],
      unverified: findings,
    };
  }
  if (anyBatchFailed) {
    return {
      status: 'partial',
      unavailableReason: lastError ?? 'one or more verification batches failed',
      kept,
      dropped,
      duplicates,
      unverified,
    };
  }
  return { status: 'verified', kept, dropped, duplicates, unverified };
}
