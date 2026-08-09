import type { SqliteConnection } from '../../connection.js';
import type { ReviewRunUsage } from '../../types.js';

export type BillingConnection = SqliteConnection;

export interface BillingUsageLookup {
  listReviewRunUsage(runId: string): ReviewRunUsage[];
}

export const CHARGEABLE_REVIEW_WHERE =
  "action NOT LIKE 'fix:%' AND action NOT LIKE 'cmd:%' AND action NOT LIKE 'scan:%'";

export function parseNewFindings(
  raw: string,
): Array<{ severity: string; file: string; line?: number }> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (item): item is { severity: string; file: string; line?: number } =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as { severity?: unknown }).severity === 'string' &&
        typeof (item as { file?: unknown }).file === 'string' &&
        ((item as { line?: unknown }).line === undefined ||
          Number.isFinite((item as { line?: unknown }).line)),
    );
  } catch {
    return undefined;
  }
}
