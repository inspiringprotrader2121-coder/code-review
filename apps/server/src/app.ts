import { Hono } from 'hono';
import type { ReviewQueue } from '@velatrix-review/queue';
import {
  isRepoAllowed,
  loadGitHubConfigFromEnv,
  parseRepoSlug,
  verifyWebhookSignature,
} from '@velatrix-review/github';
import type { ReviewJobPayload } from '@velatrix-review/queue';
import { enqueueManualReview } from './queue-runner.js';

const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

interface PullRequestWebhook {
  action: string;
  pull_request: {
    number: number;
    head: { sha: string };
    draft?: boolean;
    user?: { login: string };
  };
  repository: {
    name: string;
    owner: { login: string };
  };
}

export function createApp(queue: ReviewQueue) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, service: 'velatrix-review' }));

  app.post('/webhooks/github', async (c) => {
    const githubConfig = loadGitHubConfigFromEnv();
    const rawBody = await c.req.text();
    const signature = c.req.header('x-hub-signature-256');
    const event = c.req.header('x-github-event');

    if (!verifyWebhookSignature(githubConfig, rawBody, signature)) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    if (event !== 'pull_request') {
      return c.json({ ok: true, ignored: event ?? 'unknown' });
    }

    const payload = JSON.parse(rawBody) as PullRequestWebhook;
    const action = payload.action;

    if (!REVIEW_ACTIONS.has(action)) {
      return c.json({ ok: true, ignored: action });
    }

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pr = payload.pull_request.number;
    const headSha = payload.pull_request.head.sha;

    if (!isRepoAllowed(owner, repo, githubConfig.allowedRepo)) {
      console.log(`[webhook] ignored repo ${owner}/${repo}`);
      return c.json({ ok: true, ignored: 'repo' });
    }

    const job: ReviewJobPayload = {
      owner,
      repo,
      pr,
      headSha,
      action: action as ReviewJobPayload['action'],
      enqueuedAt: new Date().toISOString(),
    };

    const result = await queue.enqueue(job);
    console.log(
      `[webhook] ${owner}/${repo}#${pr} ${action} @ ${headSha.slice(0, 7)} → ${result.reason ?? 'queued'}`,
    );

    return c.json({ ok: true, jobId: result.jobId, reason: result.reason });
  });

  app.post('/review', async (c) => {
    const secret = process.env.REVIEW_API_SECRET;
    if (secret) {
      const auth = c.req.header('authorization');
      if (auth !== `Bearer ${secret}`) {
        return c.json({ error: 'unauthorized' }, 401);
      }
    }

    const body = await c.req.json<{
      owner?: string;
      repo?: string;
      pr: number;
      headSha?: string;
      repoSlug?: string;
    }>();

    let owner = body.owner;
    let repo = body.repo;

    if (body.repoSlug) {
      const parsed = parseRepoSlug(body.repoSlug);
      owner = parsed.owner;
      repo = parsed.repo;
    }

    if (!owner || !repo || !body.pr) {
      return c.json({ error: 'owner, repo, pr required (or repoSlug + pr)' }, 400);
    }

    const job = await enqueueManualReview(queue, {
      owner,
      repo,
      pr: body.pr,
      headSha: body.headSha,
    });

    return c.json({ ok: true, job });
  });

  return app;
}
