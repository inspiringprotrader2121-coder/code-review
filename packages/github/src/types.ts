export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  botLogin: string;
  appSlug?: string;
  allowedRepo?: string;
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PullRequestMeta {
  number: number;
  title: string;
  /** PR description — states author intent; key for not flagging intentional changes */
  body?: string;
  headSha: string;
  baseSha: string;
  draft: boolean;
  authorLogin: string;
  htmlUrl: string;
  /** 'open' | 'closed' — GitHub's raw PR state (a merged PR is also 'closed') */
  state: string;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  patch?: string;
  previousFilename?: string;
  truncated: boolean;
}

/** Whether the whole PR actually reached the reviewer. Surfaced in the review so
 *  Orvex never claims "review complete / looks good to merge" when part of the PR
 *  was silently dropped (over the file cap, or a patch truncated). */
export interface DiffCoverage {
  /** candidate changed files (excluding intentionally-skipped lockfiles/binaries) */
  candidates: number;
  /** files that actually made it into the review set WITH reviewable content */
  reviewed: number;
  /** dropped because the maxFiles cap was hit — NOT reviewed */
  skippedByCap: number;
  /** patches cut at maxFileBytes — only partially reviewed */
  truncatedFiles: number;
  /** deletions (content not reviewable, expected — informational only) */
  deletedFiles: number;
  /** GitHub omitted the patch (oversized file) — changed but NOT reviewed */
  omittedPatch: number;
  /** true iff nothing was dropped by the cap, no patch was truncated, and no patch was omitted */
  complete: boolean;
}
