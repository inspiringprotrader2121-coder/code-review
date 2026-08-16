import type { ReviewJobPayload, ReviewQueue } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import {
  createInstallationOctokit,
  fetchPullRequest,
  getInstallationIdForRepo,
} from '@orvex-review/github';
import { TenantService, reviewJobAdmissionFields } from '@orvex-review/tenants';
import { loadWorkerConfig } from '../../pipeline.js';

export interface ManualReviewInput {
  owner: string;
  repo: string;
  pr: number;
  headSha?: string;
  installationId?: number;
  /** Deprecated, deliberately ignored: callers cannot bind billing attribution. */
  tenantSlug?: string;
}

/**
 * Resolves a manually requested review through an existing installation
 * binding. Browser/connect flow owns binding creation; this service never lets
 * a request body select another tenant's billing identity.
 */
export async function enqueueManualReview(
  queue: Pick<ReviewQueue, 'enqueue'>,
  input: ManualReviewInput,
  store: AppDatabase,
): Promise<ReviewJobPayload> {
  const config = loadWorkerConfig(store);
  const tenants = new TenantService(config.store);
  let installationId = input.installationId;
  let tenantId: string;

  if (installationId) {
    const installation = tenants.resolveInstallation(installationId);
    if (!installation) throw new Error(`Unknown installation_id ${installationId}`);
    tenantId = installation.tenantId;
  } else {
    const existing = config.store.findInstallationForRepo(input.owner, input.repo);
    if (existing) {
      installationId = existing.installationId;
      tenantId = existing.tenantId;
    } else {
      const resolvedInstallationId = await getInstallationIdForRepo(
        config.github,
        input.owner,
        input.repo,
      );
      const bound = config.store.getInstallation(resolvedInstallationId);
      if (!bound) {
        throw new Error(
          `Installation ${resolvedInstallationId} for ${input.owner}/${input.repo} is not bound to a workspace — complete the GitHub App connect flow first`,
        );
      }
      installationId = bound.installationId;
      tenantId = bound.tenantId;
    }
  }

  const octokit = createInstallationOctokit(config.github, installationId);
  const pr = await fetchPullRequest(octokit, {
    owner: input.owner,
    repo: input.repo,
    number: input.pr,
  });
  const job: ReviewJobPayload = {
    installationId,
    tenantId,
    owner: input.owner,
    repo: input.repo,
    pr: input.pr,
    headSha: input.headSha ?? pr.headSha,
    action: 'manual',
    ...reviewJobAdmissionFields(input.owner, config.store.getTenantPlan(tenantId), undefined, {
      slug: config.store.getTenantById(tenantId)?.slug,
    }),
    enqueuedAt: new Date().toISOString(),
  };
  await queue.enqueue(job);
  return job;
}
