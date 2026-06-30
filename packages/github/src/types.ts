export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  botLogin: string;
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
  headSha: string;
  baseSha: string;
  draft: boolean;
  authorLogin: string;
  htmlUrl: string;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  patch?: string;
  previousFilename?: string;
  truncated: boolean;
}
