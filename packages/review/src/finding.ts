import { createHash } from 'node:crypto';

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: 'P1' | 'P2' | 'P3' | 'info';
  category: string;
  message: string;
  suggestion?: string;
  /** exact source snippet the fix replaces (anchor for safe auto-apply) */
  originalCode?: string;
  /** machine-applicable replacement for originalCode */
  fixedCode?: string;
  confidence: number;
  ruleId: string;
}

export function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim()
    .slice(0, 80);
}

/**
 * Version tag on the fingerprint recipe. Bump when the stem changes so old and
 * new fingerprints are distinguishable — prevents a recipe change from silently
 * mismatching every stored fingerprint (false "resolved", re-posts, dead
 * suppressions). Stored fingerprints carry their version as the "vN-" prefix.
 */
export const FINGERPRINT_VERSION = 2;

export function fingerprintFinding(
  f: Pick<ReviewFinding, 'file' | 'ruleId' | 'message'>,
): string {
  // Line-independent on purpose: pushes shift line numbers, and a shifted
  // finding is the SAME finding. The message (normalized) is the per-occurrence
  // discriminator, so two genuinely different issues don't collapse.
  const stem = [f.file, f.ruleId, normalizeMessage(f.message)].join('|');
  const hash = createHash('sha256').update(stem).digest('hex').slice(0, 16);
  return `v${FINGERPRINT_VERSION}-${hash}`;
}

export function findingId(fingerprint: string, headSha: string): string {
  return `${fingerprint}-${headSha.slice(0, 7)}`;
}
