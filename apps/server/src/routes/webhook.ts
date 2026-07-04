import { Hono } from 'hono';
import type { ReviewQueue } from '@velatrix-review/queue';
import type { ReviewJobPayload } from '@velatrix-review/queue';
import {
  createInstallationOctokit,
  isRepoAllowed,
  loadGitHubConfigFromEnv,
  addIssueCommentReaction,
  postPrComment,
  verifyWebhookSignature,
} from '@velatrix-review/github';
import { TenantService } from '@velatrix-review/tenants';
import { createAppDatabase } from '@velatrix-review/store';
import { enqueueManualReview } from '../queue-runner.js';

const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

interface WebhookInstallation {
  id: number;
  account?: { login?: string; type?: string };
  repository_selection?: string;
  suspended_at?: string | null;
}

interface PullRequestWebhook {
  action: string;
  installation?: WebhookInstallation;
  pull_request: {
    number: number;
    head: { sha: string };
  };
  repository: {
    name: string;
    owner: { login: string };
  };
}

interface IssueCommentWebhook {
  action: string;
  installation?: WebhookInstallation;
  comment?: {
    id: number;
    body?: string;
    user?: { login?: string };
  };
  issue?: {
    number: number;
    pull_request?: Record<string, unknown>;
  };
  repository: {
    name: string;
    owner: { login: string };
  };
}

interface InstallationWebhook {
  action: string;
  installation: WebhookInstallation;
}

export function webhookRoutes(queue: ReviewQueue) {
  const app = new Hono();
  const tenants = new TenantService();
  const db = createAppDatabase();

  app.post('/webhooks/github', async (c) => {
    const githubConfig = loadGitHubConfigFromEnv();
    const rawBody = await c.req.text();
    const signature = c.req.header('x-hub-signature-256');
    const event = c.req.header('x-github-event');

    if (!verifyWebhookSignature(githubConfig, rawBody, signature)) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;

    if (event === 'installation') {
      const data = payload as unknown as InstallationWebhook;
      const inst = data.installation;
      if (!inst?.id) return c.json({ ok: true });

      if (data.action === 'deleted') {
        db.upsertInstallation({
          installationId: inst.id,
          tenantId: db.getInstallation(inst.id)?.tenantId ?? db.createTenant(`deleted-${inst.id}`).id,
          accountLogin: inst.account?.login ?? 'unknown',
          accountType: inst.account?.type ?? 'Organization',
          repositorySelection: inst.repository_selection ?? 'selected',
          suspendedAt: new Date().toISOString(),
        });
        return c.json({ ok: true, action: 'deleted' });
      }

      const existing = tenants.resolveInstallation(inst.id);
      if (!existing) {
        console.warn(
          `[webhook] ignored unclaimed installation ${data.action} id=${inst.id} account=${inst.account?.login}`,
        );
        return c.json({ ok: true, ignored: 'unclaimed_installation' });
      }

      await tenants.syncInstallationFromWebhook(inst.id, existing.tenantId, {
        accountLogin: inst.account?.login ?? 'unknown',
        accountType: inst.account?.type ?? 'Organization',
        repositorySelection: inst.repository_selection ?? 'selected',
        suspendedAt: inst.suspended_at ?? null,
      });

      console.log(`[webhook] installation ${data.action} id=${inst.id} account=${inst.account?.login}`);
      return c.json({ ok: true, action: data.action });
    }

    if (event === 'installation_repositories') {
      console.log(`[webhook] installation_repositories ${payload.action}`);
      return c.json({ ok: true });
    }

    if (event === 'issue_comment') {
      const data = payload as unknown as IssueCommentWebhook;
      if (data.action !== 'created') {
        return c.json({ ok: true, ignored: `issue_comment:${data.action}` });
      }

      const body = data.comment?.body ?? '';
      const actor = data.comment?.user?.login ?? '';
      if (!body || !actor) {
        return c.json({ ok: true, ignored: 'missing_comment_or_author' });
      }

      const appSlug = githubConfig.appSlug ?? 'velatrix-review';
      if (!isReviewCommand(body, appSlug)) {
        return c.json({ ok: true, ignored: 'no_review_command' });
      }

      if (actor.toLowerCase().endsWith('[bot]')) {
        return c.json({ ok: true, ignored: 'bot_comment' });
      }

      if (!data.issue?.pull_request) {
        return c.json({ ok: true, ignored: 'not_pull_request' });
      }

      const installationId = data.installation?.id;
      if (!installationId) {
        return c.json({ error: 'missing installation on issue_comment event' }, 400);
      }
      const installation = tenants.resolveInstallation(installationId);
      if (!installation || installation.suspendedAt) {
        console.warn(`[webhook] ignored manual review for unclaimed installation ${installationId}`);
        return c.json({ ok: true, ignored: 'unclaimed_installation' });
      }

      const owner = data.repository.owner.login;
      const repo = data.repository.name;
      const pr = data.issue.number;
      const commentId = data.comment?.id;
      if (!commentId) {
        return c.json({ error: 'missing issue_comment id' }, 400);
      }

      if (githubConfig.allowedRepo && !isRepoAllowed(owner, repo, githubConfig.allowedRepo)) {
        return c.json({ ok: true, ignored: 'repo' });
      }

      const octokit = createInstallationOctokit(githubConfig, installationId);
      let job: ReviewJobPayload;
      try {
        job = await enqueueManualReview(queue, {
          owner,
          repo,
          pr,
          installationId,
        });
        await postPrComment(
          octokit,
          { owner, repo, number: pr },
          `✅ Review request accepted for #${pr} with action ${job.action} on ${job.headSha.slice(0, 7)}.`,
        );
        try {
          await addIssueCommentReaction(octokit, owner, repo, commentId, 'rocket');
        } catch (reactionErr) {
          console.warn('[webhook] failed to add acknowledgement reaction', {
            owner,
            repo,
            pr,
            commentId,
            err: reactionErr instanceof Error ? reactionErr.message : String(reactionErr),
          });
        }
      } catch (err) {
        try {
          await postPrComment(
            octokit,
            { owner, repo, number: pr },
            '⚠️ Review request could not be queued right now. I could not access this PR right now.',
          );
        } catch (notifyErr) {
          console.warn('[webhook] failed to post review queue error comment', {
            owner,
            repo,
            pr,
            err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          });
        }
        throw err;
      }

      return c.json({ ok: true, triggeredBy: actor, action: 'review', jobId: job.headSha });
    }

    if (event !== 'pull_request') {
      return c.json({ ok: true, ignored: event ?? 'unknown' });
    }

    const prPayload = payload as unknown as PullRequestWebhook;
    const action = prPayload.action;

    if (!REVIEW_ACTIONS.has(action)) {
      return c.json({ ok: true, ignored: action });
    }

    const installationId = prPayload.installation?.id;
    if (!installationId) {
      return c.json({ error: 'missing installation on pull_request event' }, 400);
    }

    const owner = prPayload.repository.owner.login;
    const repo = prPayload.repository.name;
    const pr = prPayload.pull_request.number;
    const headSha = prPayload.pull_request.head.sha;

    if (githubConfig.allowedRepo && !isRepoAllowed(owner, repo, githubConfig.allowedRepo)) {
      console.log(`[webhook] ignored repo ${owner}/${repo} (legacy allowlist)`);
      return c.json({ ok: true, ignored: 'repo' });
    }

    let installation = tenants.resolveInstallation(installationId);
    if (!installation) {
      console.warn(`[webhook] ignored PR for unclaimed installation ${installationId} ${owner}/${repo}#${pr}`);
      return c.json({ ok: true, ignored: 'unclaimed_installation' });
    }

    if (!installation || installation.suspendedAt) {
      return c.json({ ok: true, ignored: 'suspended_or_unknown_installation' });
    }

    const job: ReviewJobPayload = {
      installationId,
      tenantId: installation.tenantId,
      owner,
      repo,
      pr,
      headSha,
      action: action as ReviewJobPayload['action'],
      enqueuedAt: new Date().toISOString(),
    };

    const result = await queue.enqueue(job);
    console.log(
      `[webhook] tenant=${installation.tenantId.slice(0, 8)} inst=${installationId} ` +
        `${owner}/${repo}#${pr} ${action} @ ${headSha.slice(0, 7)} → ${result.reason ?? 'queued'}`,
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
      installationId?: number;
      tenantSlug?: string;
    }>();

    let owner = body.owner;
    let repo = body.repo;
    if (body.repoSlug) {
      const [o, r] = body.repoSlug.split('/');
      owner = o;
      repo = r;
    }

    if (!owner || !repo || !body.pr) {
      return c.json({ error: 'owner, repo, pr required' }, 400);
    }

    const job = await enqueueManualReview(queue, {
      owner,
      repo,
      pr: body.pr,
      headSha: body.headSha,
      installationId: body.installationId,
      tenantSlug: body.tenantSlug,
    });

    return c.json({ ok: true, job });
  });

  return app;
}

function isReviewCommand(body: string, appSlug: string): boolean {
  if (/\b\/(?:review|velatrix-review)\b/i.test(body)) {
    return true;
  }

  const aliases = [...new Set([appSlug.toLowerCase(), 'velatrix-review', 'minimax', 'velatrixreview'])];
  const escapedAliases = aliases.map(escapeRegExp).join('|');
  const mention = new RegExp(`(?:^|[\\s\\W])@(?:${escapedAliases})\\s+review\\b`, 'i');
  return mention.test(body);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}
