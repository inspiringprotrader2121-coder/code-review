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

export function fingerprintFinding(f: Pick<ReviewFinding, 'file' | 'line' | 'ruleId' | 'message'>): string {
  // Deliberately line-independent: pushes shift line numbers, and a shifted
  // finding is the SAME finding — including the line here caused every
  // re-review to re-post slightly-moved findings as new inline comments.
  const stem = [f.file, f.ruleId, normalizeMessage(f.message)].join('|');
  return createHash('sha256').update(stem).digest('hex').slice(0, 16);
}

export function findingId(fingerprint: string, headSha: string): string {
  return `${fingerprint}-${headSha.slice(0, 7)}`;
}
