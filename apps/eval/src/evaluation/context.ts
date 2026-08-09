import { buildRepoContext, fetchPrDiff } from '@orvex-review/github';
import { isHighRiskDiff, type ReviewableFile } from '@orvex-review/review';
import type { EvalCase } from '../cases.js';
import type { createBenchmarkOctokit } from '../bench/github-auth.js';

export interface PreparedEvaluationContext {
  sha: string;
  files: Awaited<ReturnType<typeof fetchPrDiff>>;
  reviewable: Awaited<ReturnType<typeof fetchPrDiff>>;
  investigateFiles: ReviewableFile[];
  reviewFiles: ReviewableFile[];
  highRisk: boolean;
  context: Awaited<ReturnType<typeof buildRepoContext>> | undefined;
}

function immutableSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/** Reads the same review-input and context defaults used by production. */
export function evaluationContextLimits(env: NodeJS.ProcessEnv): {
  maxFileBytes: number;
  maxFiles: number;
  maxSourceFiles: number;
  maxRelated: number;
  maxDependents: number;
  maxContextFileBytes: number;
} {
  const positive = (value: string | undefined, fallback: number, maximum: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), maximum) : fallback;
  };
  const nonNegative = (value: string | undefined, fallback: number, maximum: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.min(Math.floor(parsed), maximum)
      : fallback;
  };
  return {
    // These values mirror packages/config/src/review.ts production defaults.
    maxFileBytes: positive(env.MAX_FILE_BYTES, 300_000, 10_000_000),
    maxFiles: positive(env.MAX_FILES, 150, 1_000),
    maxSourceFiles: nonNegative(env.ORVEX_CTX_SOURCE, 40, 500),
    maxRelated: nonNegative(env.ORVEX_CTX_RELATED, 12, 200),
    maxDependents: nonNegative(env.ORVEX_CTX_DEPENDENTS, 8, 200),
    maxContextFileBytes: nonNegative(env.ORVEX_CTX_FILE_BYTES, 120_000, 1_000_000),
  };
}

/** Loads the exact labelled base/head diff and production-aligned repository context. */
export async function prepareEvaluationContext(
  evaluationCase: EvalCase,
  octokit: Awaited<ReturnType<typeof createBenchmarkOctokit>>,
  env: NodeJS.ProcessEnv,
): Promise<PreparedEvaluationContext> {
  const limits = evaluationContextLimits(env);
  const sha = evaluationCase.sha;
  if (!immutableSha(sha))
    throw new Error(`eval case ${evaluationCase.name} has no immutable 40-character SHA`);
  if (!immutableSha(evaluationCase.baseSha) || evaluationCase.baseSha === sha) {
    throw new Error(`eval case ${evaluationCase.name} has no distinct immutable base SHA`);
  }
  const files = await fetchPrDiff(
    octokit,
    { owner: evaluationCase.owner, repo: evaluationCase.repo, number: evaluationCase.pr },
    {
      maxFileBytes: limits.maxFileBytes,
      maxFiles: limits.maxFiles,
      sinceSha: evaluationCase.baseSha,
      headSha: sha,
    },
  );
  const reviewable = files.filter((file) => file.patch && file.status !== 'removed');
  const highRisk = isHighRiskDiff(reviewable);
  let context: Awaited<ReturnType<typeof buildRepoContext>> | undefined;
  try {
    context = await buildRepoContext(
      octokit,
      evaluationCase.owner,
      evaluationCase.repo,
      sha,
      reviewable.map((file) => file.filename),
      {
        maxSourceFiles: limits.maxSourceFiles,
        maxRelated: Number(env.ORVEX_CTX_RELATED ?? (highRisk ? 18 : limits.maxRelated)),
        maxDependents: Number(env.ORVEX_CTX_DEPENDENTS ?? (highRisk ? 12 : limits.maxDependents)),
        maxFileBytes: limits.maxContextFileBytes,
        maxOthers: Number(env.ORVEX_CTX_OTHERS ?? 28 + (highRisk ? 8 : 0)),
      },
    );
  } catch {
    // Context retrieval is best effort; the immutable diff remains a valid input.
  }
  return {
    sha,
    files,
    reviewable,
    investigateFiles: files
      .filter((file) => file.patch)
      .map((file) => ({
        filename: file.filename,
        status: file.status ?? 'modified',
        patch: file.patch ?? undefined,
      })),
    reviewFiles: reviewable.map((file) => ({
      filename: file.filename,
      status: file.status ?? 'modified',
      patch: file.patch ?? undefined,
    })),
    highRisk,
    context,
  };
}

export function verificationContext(
  prepared: PreparedEvaluationContext,
): Array<{ path: string; content: string }> {
  const contextFiles = prepared.context
    ? [
        ...prepared.context.changedContents,
        ...prepared.context.related,
        ...prepared.context.dependents,
        ...prepared.context.others,
      ]
    : [];
  const knownPaths = new Set(contextFiles.map((file) => file.path));
  for (const file of prepared.reviewFiles) {
    if (!knownPaths.has(file.filename) && file.patch) {
      contextFiles.push({
        path: file.filename,
        content: `Diff (changed lines) for this file:\n${file.patch}`,
      });
      knownPaths.add(file.filename);
    }
  }
  return contextFiles;
}
