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
  installationId: number;
  tenantId: string;
  owner: string;
  repo: string;
  pr: number;
  lastSha: string;
  findings: StoredFinding[];
  lastReviewAt: string;
  lastSummaryCommentId?: number;
}

export interface PrKey {
  installationId: number;
  owner: string;
  repo: string;
  pr: number;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

export interface GitHubInstallation {
  installationId: number;
  tenantId: string;
  accountLogin: string;
  accountType: 'Organization' | 'User' | string;
  repositorySelection: 'all' | 'selected' | string;
  suspendedAt?: string;
  createdAt: string;
  updatedAt: string;
}
