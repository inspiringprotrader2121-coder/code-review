import { Hono } from 'hono';
import type { ReviewQueue } from '@orvex-review/queue';
import type { FixRequest, ReviewJobPayload } from '@orvex-review/queue';
import {
  addCommentReaction,
  createInstallationOctokit,
  fetchPullRequest,
  isRepoAllowed,
  loadGitHubConfigFromEnv,
  replyToIssueComment,
  replyToReviewComment,
  verifyWebhookSignature,
  type GitHubAppConfig,
} from '@orvex-review/github';
import {
  applyCheckboxChecked,
  commandTrigger,
  formatAutoApplyReply,
  formatFixSkippedReply,
  formatHelpComment,
  parseApplyMarker,
  parseOrvexCommand,
} from '@orvex-review/review';
import { TenantService } from '@orvex-review/tenants';
import { createAppDatabase, type GitHubInstallation } from '@orvex-review/store';
import { enqueueManualReview } from '../queue-runner.js';

const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);
const WRITE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

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
}

interface RepositoryLite {
  id: number;
  name: string;
  full_name: string;
  private?: boolean;
  default_branch?: string;
}

interface InstallationRepositoriesWebhook {
  action: string;
  installation: WebhookInstallation;
  repositories_added?: RepositoryLite[];
  repositories_removed?: RepositoryLite[];
  repositories?: RepositoryLite[];
}

interface InstallationWebhook {
  action: string;
  installation: WebhookInstallation;
}

interface CommentWebhook {
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

export function webhookRoutes(queue: ReviewQueue) {
  const app = new Hono();
  const tenants = new TenantService();
  const db = createAppDatabase();

  /** Upsert the repos an installation can access into the dashboard repo list. */
  function syncReposFromPayload(installationId: number, repos: RepositoryLite[]): void {
    if (repos.length === 0) return;
    const installation = db.getInstallation(installationId);
    if (!installation) return;
    const settings = db.getWorkspaceSettings(installation.tenantId);
    for (const r of repos) {
      if (!r?.id || !r.name) continue;
      const owner = r.full_name?.split('/')[0] ?? installation.accountLogin;
      db.upsertRepo({
        installationId,
        tenantId: installation.tenantId,
        githubRepoId: r.id,
        owner,
        name: r.name,
        fullName: r.full_name ?? `${owner}/${r.name}`,
        private: r.private,
        defaultBranch: r.default_branch,
        enabled: settings.autoEnableNewRepos,
      });
    }
  }

  async function resolveActiveInstallation(
    payload: { installation?: WebhookInstallation },
    owner: string,
  ): Promise<GitHubInstallation | null> {
    const installationId = payload.installation?.id;
    if (!installationId) return null;

    let installation = tenants.resolveInstallation(installationId);
    if (!installation) {
      installation = await tenants.syncInstallationFromWebhook(installationId, null, {
        accountLogin: payload.installation?.account?.login ?? owner,
        accountType: payload.installation?.account?.type ?? 'Organization',
        repositorySelection: payload.installation?.repository_selection ?? 'selected',
      });
    }
    if (!installation || installation.suspendedAt) return null;
    return installation;
  }

  async function enqueueCommandJob(
    githubConfig: GitHubAppConfig,
    installation: GitHubInstallation,
    owner: string,
    repo: string,
    pr: number,
    kind: 'review' | 'fix' | 'explain',
    fix?: FixRequest,
  ): Promise<void> {
    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
    const prMeta = await fetchPullRequest(octokit, { owner, repo, number: pr });
    const job: ReviewJobPayload = {
      kind,
      installationId: installation.installationId,
      tenantId: installation.tenantId,
      owner,
      repo,
      pr,
      headSha: prMeta.headSha,
      action: 'command',
      fix,
      enqueuedAt: new Date().toISOString(),
    };
    const result = await queue.enqueue(job);
    console.log(
      `[webhook] command ${kind}${fix ? `:${fix.scope}` : ''} ${owner}/${repo}#${pr} → ${result.reason ?? 'queued'}`,
    );
  }

  /** `@orvex …` in a PR-level (issue) comment. */
  async function handleIssueComment(
    githubConfig: GitHubAppConfig,
    data: CommentWebhook,
  ): Promise<string> {
    if (data.action !== 'created') return 'ignored_action';
    if (!data.issue?.pull_request) return 'not_a_pr';
    if (data.comment.user.login === githubConfig.botLogin) return 'own_comment';

    const command = parseOrvexCommand(data.comment.body);
    if (!command) return 'no_command';

    if (!WRITE_ASSOCIATIONS.has(data.comment.author_association ?? '')) {
      return 'insufficient_permissions';
    }

    const owner = data.repository.owner.login;
    const repo = data.repository.name;
    const pr = data.issue.number;
    const installation = await resolveActiveInstallation(data, owner);
    if (!installation) return 'no_installation';

    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
    const ref = { owner, repo, number: pr };
    await addCommentReaction(octokit, owner, repo, data.comment.id, 'eyes', false);

    const requestedBy = data.sender.login;
    const baseFix = { replyToCommentId: data.comment.id, isReviewComment: false, requestedBy };

    switch (command.kind) {
      case 'review':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'review');
        return 'review_enqueued';
      case 'fix':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
          ...baseFix,
          scope: 'ready',
        });
        return 'fix_enqueued';
      case 'fix_all':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
          ...baseFix,
          scope: 'all',
        });
        return 'fix_all_enqueued';
      case 'auto_apply': {
        db.setPrAutoApply({ installationId: installation.installationId, owner, repo, pr }, command.enabled);
        await replyToIssueComment(octokit, ref, formatAutoApplyReply(command.enabled, commandTrigger()));
        if (command.enabled) {
          await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
            ...baseFix,
            scope: 'ready',
          });
        }
        return 'auto_apply_set';
      }
      case 'fix_this':
      case 'ignore':
      case 'explain':
      case 'prompt':
        await replyToIssueComment(
          octokit,
          ref,
          formatFixSkippedReply(
            `reply directly on one of Orvex's inline findings to use \`${commandTrigger()} fix this\`, \`ignore\`, \`explain\`, or a custom instruction.`,
          ),
        );
        return 'needs_thread_context';
      case 'help':
      default:
        await replyToIssueComment(octokit, ref, formatHelpComment(commandTrigger()));
        return 'help_posted';
    }
  }

  /** `@orvex …` replies and apply-checkbox toggles on inline review comments. */
  async function handleReviewComment(
    githubConfig: GitHubAppConfig,
    data: CommentWebhook,
  ): Promise<string> {
    const owner = data.repository.owner.login;
    const repo = data.repository.name;
    const pr = data.pull_request?.number;
    if (!pr) return 'no_pr';

    // checkbox toggled on one of our own finding comments
    if (data.action === 'edited' && data.comment.user.login === githubConfig.botLogin) {
      if (data.sender.login === githubConfig.botLogin) return 'own_edit';
      if (!applyCheckboxChecked(data.changes?.body?.from, data.comment.body)) return 'not_a_check';
      const fingerprint = parseApplyMarker(data.comment.body);
      if (!fingerprint) return 'no_marker';

      const installation = await resolveActiveInstallation(data, owner);
      if (!installation) return 'no_installation';

      await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
        scope: 'one',
        fingerprint,
        replyToCommentId: data.comment.id,
        isReviewComment: true,
        requestedBy: data.sender.login,
      });
      return 'checkbox_fix_enqueued';
    }

    if (data.action !== 'created') return 'ignored_action';
    if (data.comment.user.login === githubConfig.botLogin) return 'own_comment';

    const command = parseOrvexCommand(data.comment.body);
    if (!command) return 'no_command';
    if (!WRITE_ASSOCIATIONS.has(data.comment.author_association ?? '')) {
      return 'insufficient_permissions';
    }

    const installation = await resolveActiveInstallation(data, owner);
    if (!installation) return 'no_installation';

    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
    await addCommentReaction(octokit, owner, repo, data.comment.id, 'eyes', true);

    // the thread root is Orvex's finding comment
    const threadRootId = data.comment.in_reply_to_id ?? data.comment.id;
    const requestedBy = data.sender.login;

    switch (command.kind) {
      case 'review':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'review');
        return 'review_enqueued';
      case 'fix':
      case 'fix_this':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
          scope: 'one',
          replyToCommentId: threadRootId,
          isReviewComment: true,
          requestedBy,
        });
        return 'thread_fix_enqueued';
      case 'fix_all':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
          scope: 'all',
          replyToCommentId: threadRootId,
          isReviewComment: true,
          requestedBy,
        });
        return 'fix_all_enqueued';
      case 'prompt':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
          scope: 'one',
          instruction: command.instruction,
          replyToCommentId: threadRootId,
          isReviewComment: true,
          requestedBy,
        });
        return 'prompt_fix_enqueued';
      case 'ignore': {
        const key = { installationId: installation.installationId, owner, repo, pr };
        const state = db.getState(key);
        const finding = state?.findings.find((f) => f.githubCommentId === threadRootId);
        if (!finding) {
          await replyToReviewComment(
            octokit,
            owner,
            repo,
            pr,
            threadRootId,
            formatFixSkippedReply('could not match this thread to an Orvex finding.'),
          );
          return 'ignore_no_finding';
        }
        db.addSuppression({
          installationId: installation.installationId,
          owner,
          repo,
          fingerprint: finding.fingerprint,
          ruleId: finding.ruleId,
          suppressedBy: requestedBy,
        });
        finding.status = 'ignored';
        if (state) db.saveState(state);
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          pr,
          threadRootId,
          `🙈 **Ignored** — Orvex won't report this finding again on \`${owner}/${repo}\` (suppressed by @${requestedBy}).`,
        );
        return 'finding_ignored';
      }
      case 'explain':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'explain', {
          scope: 'one',
          replyToCommentId: threadRootId,
          isReviewComment: true,
          requestedBy,
        });
        return 'explain_enqueued';
      case 'auto_apply': {
        db.setPrAutoApply({ installationId: installation.installationId, owner, repo, pr }, command.enabled);
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          pr,
          threadRootId,
          formatAutoApplyReply(command.enabled, commandTrigger()),
        );
        return 'auto_apply_set';
      }
      case 'help':
      default:
        await replyToReviewComment(octokit, owner, repo, pr, threadRootId, formatHelpComment(commandTrigger()));
        return 'help_posted';
    }
  }

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

      // installation.created / .new_permissions_accepted carry the accessible repo list
      syncReposFromPayload(
        inst.id,
        (payload as unknown as InstallationRepositoriesWebhook).repositories ?? [],
      );

      console.log(`[webhook] installation ${data.action} id=${inst.id} account=${inst.account?.login}`);
      return c.json({ ok: true, action: data.action });
    }

    if (event === 'installation_repositories') {
      const data = payload as unknown as InstallationRepositoriesWebhook;
      const inst = data.installation;
      if (inst?.id) {
        syncReposFromPayload(inst.id, [
          ...(data.repositories_added ?? []),
          ...(data.repositories ?? []),
        ]);
      }
      console.log(`[webhook] installation_repositories ${payload.action}`);
      return c.json({ ok: true, action: payload.action });
    }

    if (event === 'issue_comment') {
      const outcome = await handleIssueComment(githubConfig, payload as unknown as CommentWebhook);
      return c.json({ ok: true, outcome });
    }

    if (event === 'pull_request_review_comment') {
      const outcome = await handleReviewComment(githubConfig, payload as unknown as CommentWebhook);
      return c.json({ ok: true, outcome });
    }

    if (event !== 'pull_request') {
      return c.json({ ok: true, ignored: event ?? 'unknown' });
    }

    const prPayload = payload as unknown as PullRequestWebhook;
    const action = prPayload.action;

    // record lifecycle for open/close/merge/reopen/edit even when we don't re-review
    const LIFECYCLE_ACTIONS = new Set([...REVIEW_ACTIONS, 'closed', 'edited', 'ready_for_review']);
    if (!LIFECYCLE_ACTIONS.has(action)) {
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
    const fullName = prPayload.repository.full_name ?? `${owner}/${repo}`;

    if (githubConfig.allowedRepo && !isRepoAllowed(owner, repo, githubConfig.allowedRepo)) {
      console.log(`[webhook] ignored repo ${owner}/${repo} (legacy allowlist)`);
      return c.json({ ok: true, ignored: 'repo' });
    }

    const installation = await resolveActiveInstallation(prPayload, owner);
    if (!installation) {
      return c.json({ ok: true, ignored: 'suspended_or_unknown_installation' });
    }

    // ensure the repo is tracked (first PR on a repo we haven't synced yet)
    if (prPayload.repository.id && !db.getRepoByFullName(installationId, fullName)) {
      syncReposFromPayload(installationId, [
        {
          id: prPayload.repository.id,
          name: repo,
          full_name: fullName,
          private: prPayload.repository.private,
          default_branch: prPayload.repository.default_branch,
        },
      ]);
    }

    // record the PR's current lifecycle state
    const prState = prPayload.pull_request.merged
      ? 'merged'
      : action === 'closed' || prPayload.pull_request.state === 'closed'
        ? 'closed'
        : 'open';
    db.upsertPullRequest({
      tenantId: installation.tenantId,
      installationId,
      repoFullName: fullName,
      number: pr,
      title: prPayload.pull_request.title ?? `#${pr}`,
      author: prPayload.pull_request.user?.login ?? 'unknown',
      state: prState,
      draft: prPayload.pull_request.draft,
      headSha,
      url: prPayload.pull_request.html_url,
      openedAt: prPayload.pull_request.created_at ?? undefined,
      closedAt: prPayload.pull_request.closed_at ?? undefined,
      mergedAt: prPayload.pull_request.merged_at ?? undefined,
    });

    if (!REVIEW_ACTIONS.has(action)) {
      return c.json({ ok: true, recorded: prState, reviewed: false });
    }

    // respect the per-repo enable toggle from the dashboard
    if (!db.isRepoEnabled(installationId, fullName)) {
      console.log(`[webhook] ${fullName} disabled for review — recorded PR only`);
      return c.json({ ok: true, recorded: prState, reviewed: false, reason: 'repo_disabled' });
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
