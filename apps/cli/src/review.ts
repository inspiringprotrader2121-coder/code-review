#!/usr/bin/env tsx
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { MemoryReviewQueue } from '@orvex-review/queue';
import {
  createInstallationOctokit,
  fetchPullRequest,
  getInstallationIdForRepo,
  parseRepoSlug,
} from '@orvex-review/github';
import { TenantService } from '@orvex-review/tenants';
import { enqueueManualReview, startWorkerLoop } from '../../server/src/queue-runner.js';
import { loadWorkerConfig, processReviewJob } from '../../server/src/worker.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', short: 'r' },
    pr: { type: 'string', short: 'p' },
    sync: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals[0] !== 'review') {
  console.log(`Usage:
  pnpm review --pr <number> --repo owner/repo [--sync]

Examples:
  pnpm review --pr 67 --repo my-org/my-repo
  pnpm review --pr 67 --repo my-org/my-repo --sync   # run inline, no queue
`);
  process.exit(values.help ? 0 : 1);
}

const prNumber = Number(values.pr);
if (!values.pr || Number.isNaN(prNumber)) {
  console.error('Missing --pr <number>');
  process.exit(1);
}
if (!values.repo) {
  console.error('Missing --repo owner/repo');
  process.exit(1);
}

const { owner, repo } = parseRepoSlug(values.repo);

async function resolveBoundInstallation(config: ReturnType<typeof loadWorkerConfig>) {
  const tenants = new TenantService(config.store);
  const existing = config.store.findInstallationForRepo(owner, repo);
  if (existing) {
    const inst = tenants.resolveInstallation(existing.installationId);
    if (!inst) throw new Error(`Unknown installation_id ${existing.installationId}`);
    return { installationId: existing.installationId, tenantId: existing.tenantId };
  }
  const installationIdFromGithub = await getInstallationIdForRepo(config.github, owner, repo);
  const bound = config.store.getInstallation(installationIdFromGithub);
  if (!bound) {
    throw new Error(
      `Installation ${installationIdFromGithub} for ${owner}/${repo} is not bound to a workspace — complete the GitHub App connect flow first`,
    );
  }
  return { installationId: bound.installationId, tenantId: bound.tenantId };
}

async function main() {
  if (values.sync) {
    const config = loadWorkerConfig();
    const { installationId, tenantId } = await resolveBoundInstallation(config);
    const octokit = createInstallationOctokit(config.github, installationId);
    const pr = await fetchPullRequest(octokit, { owner, repo, number: prNumber });

    const job = {
      installationId,
      tenantId,
      owner,
      repo,
      pr: prNumber,
      headSha: pr.headSha,
      action: 'manual' as const,
      enqueuedAt: new Date().toISOString(),
    };

    const result = await processReviewJob(job, config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Never attach a local CLI worker to the shared Redis queue — that would
  // compete with production workers. Memory queue keeps this process isolated.
  const queue = new MemoryReviewQueue();
  const stop = startWorkerLoop(queue);
  const job = await enqueueManualReview(queue, { owner, repo, pr: prNumber });
  console.log(`Enqueued ${owner}/${repo}#${prNumber} @ ${job.headSha.slice(0, 7)}`);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  await queue.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
