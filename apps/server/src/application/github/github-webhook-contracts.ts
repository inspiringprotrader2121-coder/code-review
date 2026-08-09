import type { ReviewJobPayload } from '@orvex-review/queue';
import type {
  BillingRepository,
  IdentityRepository,
  RepositoryWriteRepository,
  ReviewStateRepository,
} from '@orvex-review/store';
import type { TenantService, TenantServiceStore } from '@orvex-review/tenants';
import type { QuotaStatusStore } from '../../quota-status.js';
import type { ServerConfig } from '../../bootstrap/config.js';
import type { GitHubAppConfig } from '@orvex-review/github';
import type { WebhookDeliveryStore } from './webhook-delivery-service.js';

export interface WebhookInstallation {
  id: number;
  account?: { login?: string; type?: string };
  repository_selection?: string;
  suspended_at?: string | null;
}

export interface RepositoryLite {
  id: number;
  name: string;
  full_name: string;
  private?: boolean;
  default_branch?: string;
}

export interface PullRequestWebhook {
  action: string;
  installation?: WebhookInstallation;
  pull_request: {
    number: number;
    title?: string;
    state?: string;
    draft?: boolean;
    merged?: boolean;
    html_url?: string;
    user?: { login?: string };
    head: { sha: string };
    created_at?: string;
    closed_at?: string | null;
    merged_at?: string | null;
  };
  repository: {
    id?: number;
    name: string;
    full_name?: string;
    private?: boolean;
    default_branch?: string;
    owner: { login: string };
  };
  sender?: { login?: string };
}

export interface InstallationRepositoriesWebhook {
  action: string;
  installation: WebhookInstallation;
  repositories_added?: RepositoryLite[];
  repositories_removed?: RepositoryLite[];
  repositories?: RepositoryLite[];
}

export interface InstallationWebhook {
  action: string;
  installation: WebhookInstallation;
}

export interface CommentWebhook {
  action: string;
  installation?: WebhookInstallation;
  comment: {
    id: number;
    body: string;
    user: { login: string; type?: string };
    author_association?: string;
    in_reply_to_id?: number;
  };
  changes?: { body?: { from?: string } };
  issue?: { number: number; pull_request?: unknown };
  pull_request?: { number: number };
  repository: { name: string; owner: { login: string } };
  sender: { login: string };
}

export type WebhookRepositoryStore = TenantServiceStore &
  ReviewStateRepository &
  RepositoryWriteRepository & {
    getRepoByGitHubId(
      installationId: number,
      githubRepoId: number,
    ): ReturnType<RepositoryWriteRepository['upsertRepo']> | null;
    getRepoByFullName(
      installationId: number,
      fullName: string,
    ): ReturnType<RepositoryWriteRepository['upsertRepo']> | null;
  } & Pick<BillingRepository, 'getTenantPlan' | 'setTenantPlan'> &
  Pick<IdentityRepository, 'getSessionUser' | 'upsertUserFromGitHub'> &
  WebhookDeliveryStore;

export interface GithubWebhookEventDependencies {
  db: WebhookRepositoryStore & QuotaStatusStore;
  config: ServerConfig;
  tenants?: TenantService;
  githubConfig?: GitHubAppConfig;
  manualReview?: (input: {
    owner: string;
    repo: string;
    pr: number;
    headSha?: string;
    installationId?: number;
    tenantSlug?: string;
  }) => Promise<ReviewJobPayload>;
}

export interface WebhookRouteDependencies extends GithubWebhookEventDependencies {
  db: GithubWebhookEventDependencies['db'] & WebhookDeliveryStore;
}

export type GithubWebhookEventResult = {
  status?: number;
  body: Record<string, unknown>;
};
