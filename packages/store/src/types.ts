export type FindingStatus = 'open' | 'fixed' | 'ignored';

export interface StoredFinding {
  id: string;
  fingerprint: string;
  file: string;
  line?: number;
  severity: string;
  category: string;
  message: string;
  suggestion?: string;
  /** exact source snippet the fix replaces (anchor for safe auto-apply) */
  originalCode?: string;
  /** machine-applicable replacement for originalCode */
  fixedCode?: string;
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

export interface User {
  id: string;
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export type WorkspaceRole = 'owner' | 'member';

export interface WorkspaceMember {
  tenantId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
}

export type ReviewRunStatus = 'completed' | 'skipped' | 'failed';

export interface ReviewRun {
  id: string;
  tenantId: string;
  installationId: number;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  action: string;
  status: ReviewRunStatus;
  skipReason?: string;
  error?: string;
  durationMs: number;
  findingsNew: number;
  findingsFixed: number;
  findingsOpen: number;
  createdAt: string;
}

export interface PrSettings {
  installationId: number;
  owner: string;
  repo: string;
  pr: number;
  /** auto-apply Orvex's ready fixes on every future review of this PR */
  autoApply: boolean;
  updatedAt: string;
}

export interface WorkspaceStats {
  sinceDays: number;
  runsTotal: number;
  runsCompleted: number;
  runsSkipped: number;
  runsFailed: number;
  findingsNew: number;
  findingsFixed: number;
  avgDurationMs: number | null;
}
