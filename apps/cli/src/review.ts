#!/usr/bin/env tsx
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createReviewQueue } from '@orvex-review/queue';
import {
  createInstallationOctokit,
  fetchPullRequest,
  getInstallationIdForRepo,
  parseRepoSlug,
} from '@orvex-review/github';
import { enqueueManualReview, startWorkerLoop } from '../../server/src/queue-runner.js';
import { loadWorkerConfig, processReviewJob } from '../../server/src/worker.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', short: 'r', default: 'Velatrixcloud/Velatrix-Cloud' },
    pr: { type: 'string', short: 'p' },
    sync: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals[0] !== 'review') {
  console.log(`Usage:
  pnpm review --pr <number> [--repo owner/repo] [--sync]

Examples:
  pnpm review --pr 67
  pnpm review --pr 67 --repo Velatrixcloud/Velatrix-Cloud
  pnpm review --pr 67 --sync   # run inline, no queue
`);
  process.exit(values.help ? 0 : 1);
}

const prNumber = Number(values.pr);
if (!values.pr || Number.isNaN(prNumber)) {
  console.error('Missing --pr <number>');
  process.exit(1);
}

const { owner, repo } = parseRepoSlug(values.repo!);

async function main() {
  if (values.sync) {
    const config = loadWorkerConfig();
    const installationId = await getInstallationIdForRepo(config.github, owner, repo);
    const octokit = createInstallationOctokit(config.github, installationId);
    const pr = await fetchPullRequest(octokit, { owner, repo, number: prNumber });

    const job = {
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

  const queue = createReviewQueue();
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
