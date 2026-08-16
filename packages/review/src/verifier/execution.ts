import { randomBytes } from 'node:crypto';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { extractJsonLoose, llmChat } from '../llm-client.js';
import type { ReviewFinding } from '../finding.js';
import type { ModelAttemptLineage } from '../providers/types.js';
import {
  VerdictSchema,
  type Verdicts,
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
const MAX_VERIFIER_FORMAT_ATTEMPTS = 2;

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
  attemptLineage: ModelAttemptLineage,
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
      attemptLineage,
      jsonContractPrefix: '{"verdicts":',
      jsonContractKeys: ['verdicts'],
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
      attemptLineage,
      jsonContractPrefix: '{"verdicts":',
      jsonContractKeys: ['verdicts'],
    });
  } catch (error) {
    console.warn('[verifier] call failed (no whole-call replay):', (error as Error).message);
    throw error;
  }
}

class VerifierContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifierContractError';
  }
}

function usableVerifierVerdicts(parsed: Verdicts, findingCount: number): Verdicts {
  const seen = new Set<number>();
  const verdicts = [];
  for (const verdict of parsed.verdicts) {
    // Ignore out-of-range and duplicate ids. A complete set of valid ids is
    // usable even when a model appends harmless extra entries; retaining the
    // first verdict makes duplicate handling deterministic.
    if (verdict.id < 0 || verdict.id >= findingCount || seen.has(verdict.id)) continue;
    seen.add(verdict.id);
    verdicts.push(verdict);
  }
  return { ...parsed, verdicts };
}

function validateVerifierResponse(
  parsed: Verdicts,
  findingCount: number,
  strict: boolean,
): Verdicts {
  const usable = usableVerifierVerdicts(parsed, findingCount);
  const seen = new Set(usable.verdicts.map((verdict) => verdict.id));
  const missingIds = Array.from({ length: findingCount }, (_, index) => index).filter(
    (index) => !seen.has(index),
  );
  if (missingIds.length > 0) {
    throw new VerifierContractError(
      `Verifier must return a verdict for every candidate id; missing=[${missingIds.join(',')}]`,
    );
  }
  if (strict && usable.verdicts.some((verdict) => verdict.verdict === 'unverified')) {
    throw new VerifierContractError(
      'Strict verification must resolve every candidate as confirmed or rejected, not unverified',
    );
  }
  return usable;
}

function parseVerifierResponse(text: string, findingCount: number, strict: boolean): Verdicts {
  return validateVerifierResponse(
    VerdictSchema.parse(extractJsonLoose(text)),
    findingCount,
    strict,
  );
}

function parseUsableVerifierResponse(text: string, findingCount: number): Verdicts {
  const usable = usableVerifierVerdicts(VerdictSchema.parse(extractJsonLoose(text)), findingCount);
  if (usable.verdicts.length === 0)
    throw new VerifierContractError('Verifier retry returned no usable candidate verdicts');
  return usable;
}

function isVerifierContractError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof VerifierContractError ||
    name === 'ZodError' ||
    /no parseable JSON|returned no text/i.test(message)
  );
}

async function verifyFindingsBatch(
  findings: ReviewFinding[],
  files: Array<{ path: string; content: string }>,
  options: VerifierOptions & { maxFileChars: number; maxTotalChars: number },
): Promise<VerificationBatchResult> {
  const sentinel = `ORVEX_DATA_${randomBytes(9).toString('hex')}`;
  const prompt = buildVerifierPrompt(findings, files, sentinel, options);
  const attemptLineage: ModelAttemptLineage = {};
  let text = await invokeVerifier(prompt.system, prompt.user, options, attemptLineage);
  let parsed;
  try {
    parsed = parseVerifierResponse(text, findings.length, options.strict === true);
  } catch (error) {
    if (!isVerifierContractError(error) || MAX_VERIFIER_FORMAT_ATTEMPTS < 2) throw error;
    console.warn(
      '[verifier] response violated the verdict JSON contract; making one bounded semantic retry',
    );
    text = await invokeVerifier(
      prompt.system,
      [
        prompt.user,
        '',
        'FORMAT RETRY: the previous response could not be validated. Re-evaluate the same',
        'candidates once and return ONLY the exact JSON object requested above. Do not use',
        'Markdown, prose outside the JSON, or omit any candidate id.',
        ...(options.strict
          ? [
              'For this strict precision check, resolve every candidate as "confirmed" or',
              '"rejected"; do not return "unverified".',
            ]
          : []),
      ].join('\n'),
      options,
      attemptLineage,
    );
    // Preserve valid per-candidate decisions after the one bounded repair.
    // Missing ids become unverified in applyVerdicts rather than discarding
    // confirmed/refuted siblings from the entire batch.
    parsed = parseUsableVerifierResponse(text, findings.length);
  }
  return applyVerdicts(findings, parsed, options.confirmedCount ?? findings.length);
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
  const configuredConcurrency = options.concurrency ?? loadReviewRuntimeConfig().verifyConcurrency;
  const concurrency = Math.max(1, Math.floor(configuredConcurrency));
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
