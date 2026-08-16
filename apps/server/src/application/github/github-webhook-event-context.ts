import type { FixRequest, ReviewJobPayload, ReviewQueue } from '@orvex-review/queue';
import {
  createInstallationOctokit,
  fetchPullRequest,
  type GitHubAppConfig,
} from '@orvex-review/github';
import { TenantService, reviewJobAdmissionFields } from '@orvex-review/tenants';
import type { GitHubInstallation } from '@orvex-review/store';
import type { ServerConfig } from '../../bootstrap/config.js';
import type {
  GithubWebhookEventDependencies,
  RepositoryLite,
  WebhookInstallation,
} from './github-webhook-contracts.js';

export class GitHubWebhookEventContext {
  readonly db: GithubWebhookEventDependencies['db'];
  readonly config: ServerConfig;
  readonly tenants: TenantService;

  constructor(
    readonly queue: ReviewQueue,
    dependencies: GithubWebhookEventDependencies,
  ) {
    this.db = dependencies.db;
    this.config = dependencies.config;
    this.tenants = dependencies.tenants ?? new TenantService(dependencies.db);
    this.githubConfig = dependencies.githubConfig;
  }

  private readonly githubConfig: GitHubAppConfig | undefined;

  getGitHubConfig(): GitHubAppConfig {
    if (!this.githubConfig) throw new Error('GitHub App is not configured');
    return this.githubConfig;
  }

  syncReposFromPayload(installationId: number, repos: RepositoryLite[]): void {
    if (repos.length === 0) return;
    const installation = this.db.getInstallation(installationId);
    if (!installation) return;
    const settings = this.db.getWorkspaceSettings(installation.tenantId);
    for (const repo of repos) {
      if (!repo?.id || !repo.name) continue;
      const owner = repo.full_name?.split('/')[0] ?? installation.accountLogin;
      this.db.upsertRepo({
        installationId,
        tenantId: installation.tenantId,
        githubRepoId: repo.id,
        owner,
        name: repo.name,
        fullName: repo.full_name ?? `${owner}/${repo.name}`,
        private: repo.private,
        defaultBranch: repo.default_branch,
        enabled: settings.autoEnableNewRepos,
      });
    }
  }

  async resolveActiveInstallation(
    payload: { installation?: WebhookInstallation },
    owner: string,
  ): Promise<GitHubInstallation | null> {
    const installationId = payload.installation?.id;
    if (!installationId) return null;
    let installation = this.tenants.resolveInstallation(installationId);
    if (!installation) {
      installation = await this.tenants.syncInstallationFromWebhook(installationId, null, {
        accountLogin: payload.installation?.account?.login ?? owner,
        accountType: payload.installation?.account?.type ?? 'Organization',
        repositorySelection: payload.installation?.repository_selection ?? 'selected',
      });
    }
    return installation?.suspendedAt ? null : installation;
  }

  async enqueueCommandJob(
    installation: GitHubInstallation,
    owner: string,
    repo: string,
    pr: number,
    kind: 'review' | 'fix' | 'explain' | 'ask' | 'resolve',
    fix?: FixRequest,
    extra?: Partial<ReviewJobPayload>,
  ): Promise<void> {
    const octokit = createInstallationOctokit(this.getGitHubConfig(), installation.installationId);
    const prMeta = await fetchPullRequest(octokit, { owner, repo, number: pr });
    const job: ReviewJobPayload = {
      ...extra,
      kind,
      installationId: installation.installationId,
      tenantId: installation.tenantId,
      owner,
      repo,
      pr,
      headSha: prMeta.headSha,
      action: 'command',
      fix,
      sourceEventId: extra?.sourceEventId ?? fix?.sourceEventId,
      ...reviewJobAdmissionFields(owner, this.db.getTenantPlan(installation.tenantId)),
      enqueuedAt: new Date().toISOString(),
    };
    const result = await this.queue.enqueue(job);
    console.log(
      `[webhook] command ${kind}${fix ? `:${fix.scope}` : ''} ${owner}/${repo}#${pr} -> ${result.reason ?? 'queued'}`,
    );
  }
}
