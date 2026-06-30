export type FindingStatus = 'open' | 'fixed';

export interface StoredFinding {
  id: string;
  fingerprint: string;
  file: string;
  line?: number;
  severity: string;
  category: string;
  message: string;
  suggestion?: string;
  confidence: number;
  ruleId: string;
  status: FindingStatus;
  githubCommentId?: number;
  fixedAtSha?: string;
  firstSeenSha: string;
  lastSeenSha: string;
}

export interface PrReviewState {
  owner: string;
  repo: string;
  pr: number;
  lastSha: string;
  findings: StoredFinding[];
  lastReviewAt: string;
  lastSummaryCommentId?: number;
}

export interface PrKey {
  owner: string;
  repo: string;
  pr: number;
}
