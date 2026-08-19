import { JsonContractMismatchError, type StructuredFailureClass } from './parsing.js';
import { createHash } from 'node:crypto';

/** Durable coverage-unit failure reasons, distinct from provider-attempt outcome. */
export type ReviewCoverageFailure =
  | 'no_parseable_review_json'
  | 'invalid_review_contract'
  | 'all_findings_unusable'
  | 'summary_claims_findings_without_valid_items'
  | 'truncated_json'
  | 'process_failed';

export function summaryConcludesNoIssues(summary?: string): boolean {
  if (!summary?.trim()) return false;
  const text = summary.toLowerCase();
  return (
    /\bno\s+(actionable\s+)?(issues|findings|problems)\b/.test(text) ||
    /\bnothing to report\b/.test(text) ||
    /\bclean (pass|review)\b/.test(text) ||
    /\blgtm\b/.test(text)
  );
}

/**
 * True when a summary asserts that issues exist. Conservative: ordinary
 * "reviewed the diff" text must not force a repair of a valid empty pass.
 */
export function summaryClaimsIssues(summary?: string): boolean {
  if (!summary?.trim() || summaryConcludesNoIssues(summary)) return false;
  return (
    /\b(found\s+\d+|must fix|blocking issue|sql injection|vulnerabilit)/i.test(summary) ||
    /\bp[123]\b/i.test(summary) ||
    /\b\d+\s+(issue|finding|bug)s?\b/i.test(summary)
  );
}

export function coverageFailureFromError(error: unknown): ReviewCoverageFailure {
  if (error instanceof JsonContractMismatchError) {
    if (error.failureClass === 'truncated_json') return 'truncated_json';
    if (
      error.failureClass === 'complete_non_json' ||
      error.failureClass === 'complete_invalid_json' ||
      error.failureClass === 'empty'
    ) {
      return 'no_parseable_review_json';
    }
    return 'invalid_review_contract';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/no parseable JSON/i.test(message)) return 'no_parseable_review_json';
  if (/summary claims findings/i.test(message))
    return 'summary_claims_findings_without_valid_items';
  if (/no usable findings/i.test(message)) return 'all_findings_unusable';
  if (/missing findings\/issues|review JSON was missing/i.test(message)) {
    return 'invalid_review_contract';
  }
  return 'invalid_review_contract';
}

export function failureClassFromError(error: unknown): StructuredFailureClass {
  if (error instanceof JsonContractMismatchError) return error.failureClass;
  const message = error instanceof Error ? error.message : String(error);
  if (/no parseable JSON/i.test(message)) return 'complete_non_json';
  if (/no usable findings|summary claims findings|missing findings/i.test(message)) {
    return 'schema_mismatch';
  }
  return 'schema_mismatch';
}

export function parseResultFromError(
  error: unknown,
): 'ok' | 'empty' | 'invalid' | 'schema_mismatch' {
  if (error instanceof JsonContractMismatchError) return error.parseResult;
  const message = error instanceof Error ? error.message : String(error);
  if (/no parseable JSON/i.test(message)) return 'invalid';
  return 'schema_mismatch';
}

export function rawFindingCount(json: unknown): number {
  if (Array.isArray(json)) return json.length;
  if (!json || typeof json !== 'object') return 0;
  const root = json as Record<string, unknown>;
  if (Array.isArray(root.findings)) return root.findings.length;
  if (Array.isArray(root.issues)) return root.issues.length;
  return 0;
}

/** Hash only; never log the raw model text. */
export function reviewResponseFingerprint(text: string): {
  responseChars: number;
  responseHash: string;
} {
  return {
    responseChars: text.length,
    responseHash: createHash('sha256').update(text).digest('hex').slice(0, 12),
  };
}
