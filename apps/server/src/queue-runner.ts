import type { ReviewQueue, ReviewJobPayload } from '@velatrix-review/queue';
import { prKey } from '@velatrix-review/queue';
import {
  createInstallationOctokit,
  fetchPullRequest,
  getInstallationIdForRepo,
} from '@velatrix-review/github';
import { TenantService } from '@velatrix-review/tenants';
import { processReviewJob, loadWorkerConfig } from './worker.js';

const POLL_MS = 500;

export function startWorkerLoop(queue: ReviewQueue): () => void {
  let running = true;

  const tick = async () => {
    if (!running) return;

    const job = await queue.dequeue();
    if (!job) return;

    const pk = prKey(job);
    console.log(
      `[worker] start inst=${job.installationId} ${pk} @ ${job.headSha.slice(0, 7)} action=${job.action}`,
    );

    try {
      const config = loadWorkerConfig();
      await processReviewJob(job, config);
      await queue.markCompleted(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] failed ${pk}:`, message);
      await queue.markFailed(job, message);
    } finally {
      const next = await queue.releaseLockAndDrain(pk);
      if (next) {
        console.log(`[worker] coalesced follow-up ${pk} @ ${next.headSha.slice(0, 7)}`);
      }
    }
  };

  const interval = setInterval(() => {
    tick().catch((err) => console.error('[worker] tick error', err));
  }, POLL_MS);

  return () => {
    running = false;
    clearInterval(interval);
  };
}

export async function enqueueManualReview(
  queue: ReviewQueue,
  input: {
    owner: string;
    repo: string;
    pr: number;
    headSha?: string;
    installationId?: number;
    tenantSlug?: string;
  },
): Promise<ReviewJobPayload> {
  const config = loadWorkerConfig();
  const tenants = new TenantService(config.store);

  let installationId = input.installationId;
  let tenantId: string;

  if (installationId) {
    const inst = tenants.resolveInstallation(installationId);
    if (!inst) throw new Error(`Unknown installation_id ${installationId}`);
    tenantId = inst.tenantId;
  } else {
    const existing = config.store.findInstallationForRepo(input.owner, input.repo);
    if (existing) {
      installationId = existing.installationId;
      tenantId = existing.tenantId;
    } else {
      installationId = await getInstallationIdForRepo(config.github, input.owner, input.repo);
      const slug = input.tenantSlug ?? input.owner.toLowerCase();
      const { installation } = await tenants.completeInstallCallback(
        installationId,
        slug,
        config.github,
      );
      tenantId = installation.tenantId;
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
    enqueuedAt: new Date().toISOString(),
  };

  await queue.enqueue(job);
  return job;
}
