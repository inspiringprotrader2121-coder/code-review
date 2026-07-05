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
