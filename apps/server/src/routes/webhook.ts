import { Hono } from 'hono';
import type { ReviewQueue } from '@velatrix-review/queue';
import type { ReviewJobPayload } from '@velatrix-review/queue';
import {
  isRepoAllowed,
  loadGitHubConfigFromEnv,
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

      await tenants.syncInstallationFromWebhook(inst.id, null, {
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
      installation = await tenants.syncInstallationFromWebhook(
        installationId,
        null,
        {
          accountLogin: prPayload.installation?.account?.login ?? owner,
          accountType: prPayload.installation?.account?.type ?? 'Organization',
          repositorySelection: prPayload.installation?.repository_selection ?? 'selected',
        },
      );
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
