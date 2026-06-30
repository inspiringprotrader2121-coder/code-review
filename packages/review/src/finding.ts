import { createHash } from 'node:crypto';

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: 'P1' | 'P2' | 'P3' | 'info';
  category: string;
  message: string;
  suggestion?: string;
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
  const stem = [
    f.file,
    String(f.line ?? 0),
    f.ruleId,
    normalizeMessage(f.message),
  ].join('|');
  return createHash('sha256').update(stem).digest('hex').slice(0, 16);
}

export function findingId(fingerprint: string, headSha: string): string {
  return `${fingerprint}-${headSha.slice(0, 7)}`;
}
