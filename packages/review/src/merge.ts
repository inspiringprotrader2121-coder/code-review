import type { StoredFinding } from '@orvex-review/store';
import { auditDocIssuesOpenOnHead } from '@orvex-review/rules';
import type { ReviewFinding } from './finding.js';
import { fingerprintFinding } from './finding.js';

export interface FileReader {
  readFile(path: string, ref: string): Promise<string | null>;
}

export async function verifyFindingOnHead(
  finding: Pick<ReviewFinding, 'file' | 'ruleId' | 'message' | 'category'>,
  headSha: string,
  reader: FileReader,
): Promise<boolean> {
  const content = await reader.readFile(finding.file, headSha);
  if (!content) return false;

  if (finding.ruleId.startsWith('audit.')) {
    return auditDocIssuesOpenOnHead(content, finding.file);
  }

  // LLM / semgrep: conservative — assume still open unless audit rule cleared
  if (finding.ruleId.startsWith('llm.')) {
    return true;
  }

  if (finding.ruleId.startsWith('semgrep.')) {
    return true;
  }

  return true;
}

export interface MergeResult {
  toPost: ReviewFinding[];
  stillOpen: StoredFinding[];
  newlyFixed: StoredFinding[];
  stats: { newCount: number; fixedCount: number; openCount: number };
}

export function mergeFindings(
  incoming: ReviewFinding[],
  prior: StoredFinding[],
  headSha: string,
  opts: { minConfidence: number },
): MergeResult {
  const incomingFp = new Set<string>();
  const toPost: ReviewFinding[] = [];

  for (const f of incoming) {
    if (f.confidence < opts.minConfidence) continue;
    const fp = fingerprintFinding(f);
    incomingFp.add(fp);

    const priorOpen = prior.find((p) => p.fingerprint === fp && p.status === 'open');
    if (priorOpen) continue;

    toPost.push(f);
  }

  const stillOpen: StoredFinding[] = [];
  const newlyFixed: StoredFinding[] = [];

  for (const p of prior) {
    if (p.status !== 'open') continue;
    if (incomingFp.has(p.fingerprint)) {
      stillOpen.push({ ...p, lastSeenSha: headSha });
    } else {
      newlyFixed.push({ ...p, status: 'fixed', fixedAtSha: headSha });
    }
  }

  return {
    toPost,
    stillOpen,
    newlyFixed,
    stats: {
      newCount: toPost.length,
      fixedCount: newlyFixed.length,
      openCount: stillOpen.length + toPost.length,
    },
  };
}

export function toStoredFinding(f: ReviewFinding, headSha: string): StoredFinding {
  const fp = fingerprintFinding(f);
  return {
    id: `${fp}-${headSha.slice(0, 7)}`,
    fingerprint: fp,
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    message: f.message,
    suggestion: f.suggestion,
    originalCode: f.originalCode,
    fixedCode: f.fixedCode,
    confidence: f.confidence,
    ruleId: f.ruleId,
    status: 'open',
    firstSeenSha: headSha,
    lastSeenSha: headSha,
  };
}

export async function reconcileFixedOnHead(
  prior: StoredFinding[],
  headSha: string,
  reader: FileReader,
): Promise<{ stillOpen: StoredFinding[]; newlyFixed: StoredFinding[] }> {
  const stillOpen: StoredFinding[] = [];
  const newlyFixed: StoredFinding[] = [];

  for (const p of prior) {
    if (p.status !== 'open') {
      stillOpen.push(p);
      continue;
    }
    const open = await verifyFindingOnHead(p, headSha, reader);
    if (open) {
      stillOpen.push({ ...p, lastSeenSha: headSha });
    } else {
      newlyFixed.push({ ...p, status: 'fixed', fixedAtSha: headSha });
    }
  }

  return { stillOpen, newlyFixed };
}
