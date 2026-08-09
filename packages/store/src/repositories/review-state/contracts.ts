import type {
  GitHubInstallation,
  Repo,
  ReviewRun,
  ReviewRunStatus,
  WorkspaceSettings,
} from '../../types.js';

export type ReviewRunStartInput = {
  tenantId: string;
  installationId: number;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  action: string;
  deep?: boolean;
  freeTier?: boolean;
};

export type ReviewRunRecordInput = ReviewRunStartInput & {
  status: ReviewRunStatus;
  skipReason?: string;
  error?: string;
  durationMs: number;
  findingsNew?: number;
  findingsFixed?: number;
  findingsOpen?: number;
  /** Test seam for time-windowed quota checks. */
  createdAt?: string;
};

export type ReviewRunCompletion = {
  status: ReviewRunStatus;
  skipReason?: string;
  error?: string;
  durationMs: number;
  findingsNew?: number;
  findingsFixed?: number;
  findingsOpen?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  newFindings?: Array<{ severity: string; file: string; line?: number }>;
  deep?: boolean;
};

export interface ReviewStateLookup {
  getRepoByFullName(installationId: number, fullName: string): Repo | null;
  getInstallation(installationId: number): GitHubInstallation | null;
  getWorkspaceSettings(tenantId: string): WorkspaceSettings;
}

export interface ReviewStateBillingPort {
  debitOverageCredits(tenantId: string, runId: string, amountCents: number, note?: string): boolean;
}

export type ReviewReservationInput = ReviewRunStartInput & {
  /** @deprecated Prefer computeOverageDebit so the amount is read inside the transaction. */
  overageDebitCents?: number;
  computeOverageDebit?: () => number;
};

export type ReviewReservationResult = { ok: true; runId: string } | { ok: false; reason: string };

export type { ReviewRun };
