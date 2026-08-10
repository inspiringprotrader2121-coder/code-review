import type { ReviewSurfaceFinding } from '../finding.js';

export interface ReviewCommentMeta {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  stats?: { newCount: number; fixedCount: number; openCount: number };
  summary?: string;
  filesReviewed?: string[];
  isDeep?: boolean;
  stillOpen?: Array<{ severity: string; file: string; line?: number; message: string }>;
  trigger?: string;
  canAutofix?: boolean;
  coverage?: {
    reviewed: number;
    candidates: number;
    skippedByCap: number;
    truncatedFiles: number;
    omittedPatch?: number;
    githubCapHit?: boolean;
  };
  skippedLenses?: string[];
  reviewOnly?: ReviewSurfaceFinding[];
  verificationIncomplete?: string;
  verificationInconclusiveCount?: number;
}

export interface InlineFindingRender {
  finding: {
    severity: string;
    ruleId: string;
    message: string;
    suggestion?: string;
    originalCode?: string;
    fixedCode?: string;
    fingerprint: string;
    file?: string;
    line?: number;
  };
  trigger: string;
  canAutofix?: boolean;
  anchoredLine?: string;
  lineRelocated?: boolean;
  anchorContext?: boolean;
}

export interface FixSummaryInput {
  applied: Array<{ file: string; message: string; sha: string }>;
  skipped: Array<{ file: string; message: string; reason: string }>;
  headMoved?: boolean;
}
