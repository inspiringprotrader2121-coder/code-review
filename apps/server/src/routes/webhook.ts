import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ReviewQueue } from '@orvex-review/queue';
import type { FixRequest, ReviewJobPayload } from '@orvex-review/queue';
import {
  addCommentReaction,
  createInstallationOctokit,
  fetchPullRequest,
  isRepoAllowed,
  isPrStillOpen,
  listInstallationRepos,
  loadGitHubConfigFromEnv,
  replyToIssueComment,
  replyToReviewComment,
  updateReviewCommentBody,
  userCanWrite,
  verifyWebhookSignature,
  type GitHubAppConfig,
} from '@orvex-review/github';
import {
  applyCheckboxChecked,
  applyingLine,
  closeCodexSession,
  commandTrigger,
  formatAutoApplyReply,
  formatFixSkippedReply,
  formatHelpComment,
  parseApplyMarker,
  parseOrvexCommand,
  replaceApplyLine,
} from '@orvex-review/review';
import { TenantService, isPlanId, planFeatures } from '@orvex-review/tenants';
import { createAppDatabase, type AppDatabase, type GitHubInstallation } from '@orvex-review/store';
import { enqueueManualReview } from '../queue-runner.js';
import { authorizedAdminMutation } from './admin-auth.js';
import { formatQuotaStatusComment, loadAccountQuotaStatus } from '../quota-status.js';
import { cancelActiveReviewsForPr } from '../active-reviews.js';

/** sha256(event + NUL + body) — closes delivery-id rotation replay. */
export function githubWebhookBodyHash(event: string | undefined, rawBody: string): string {
  return createHash('sha256')
    .update(event ?? '')
    .update('\0')
    .update(rawBody)
    .digest('hex');
}

function bodyHashTtlMs(): number {
  const raw = Number(process.env.ORVEX_WEBHOOK_BODY_DEDUP_TTL_MS ?? 2 * 3600_000);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 7 * 24 * 3600_000) : 2 * 3600_000;
}
// ready_for_review: draft→ready must enqueue (drafts are skipped in the worker,
// so opened-as-draft never reviews until this event or a later push).
const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

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
  sender?: { login?: string };
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

export interface WebhookRouteDependencies {
  db?: AppDatabase;
  tenants?: TenantService;
  githubConfig?: GitHubAppConfig;
}

export function webhookRoutes(queue: ReviewQueue, dependencies: WebhookRouteDependencies = {}) {
  const app = new Hono();
  const db = dependencies.db ?? createAppDatabase();
  const tenants = dependencies.tenants ?? new TenantService(db);

  // Load the GitHub App config ONCE (lazily, on the first webhook) — it reads
  // and parses the App private key, and doing it PER REQUEST meant every
  // webhook delivery re-read the PEM from disk. Lazy (not at construction) so
  // tests can build the routes without GitHub env set.
  let githubConfig: GitHubAppConfig | null = dependencies.githubConfig ?? null;
  const getGithubConfig = (): GitHubAppConfig => (githubConfig ??= loadGitHubConfigFromEnv());

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
    kind: 'review' | 'fix' | 'explain' | 'ask' | 'resolve',
    fix?: FixRequest,
    extra?: Partial<ReviewJobPayload>,
  ): Promise<void> {
    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
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
      priority: planFeatures(db.getTenantPlan(installation.tenantId)).priority,
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
    if (!data.issue?.pull_request) return 'not_a_pr';

    // Apply-fix checkbox ticked on one of our PR-LEVEL finding comments (the
    // ones posted for findings that couldn't be anchored to a diff line —
    // summary-only findings previously had NO apply button). Mirrors the
    // inline review-comment checkbox path below.
    if (data.action === 'edited' && data.comment.user.login === githubConfig.botLogin) {
      if (data.sender.login === githubConfig.botLogin) return 'own_edit';
      if (!applyCheckboxChecked(data.changes?.body?.from, data.comment.body)) return 'not_a_check';
      const fingerprint = parseApplyMarker(data.comment.body);
      if (!fingerprint) return 'no_marker';

      const pr = data.issue.number;
      const owner = data.repository.owner.login;
      const repo = data.repository.name;
      const installation = await resolveActiveInstallation(data, owner);
      if (!installation) return 'no_installation';

      // commits to the branch → gate on the toggler's real write access
      const gateOctokit = createInstallationOctokit(githubConfig, installation.installationId);
      if (!db.isRepoEnabled(installation.installationId, `${owner}/${repo}`)) {
        await replyToIssueComment(
          gateOctokit,
          { owner, repo, number: pr },
          'Orvex is disabled for this repository. Enable it in the Orvex dashboard to use commands.',
        ).catch(() => {});
        return 'repo_disabled';
      }
      if (!(await userCanWrite(gateOctokit, owner, repo, data.sender.login))) {
        return 'insufficient_permissions';
      }

      await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
        scope: 'one',
        fingerprint,
        replyToCommentId: data.comment.id,
        isReviewComment: false,
        requestedBy: data.sender.login,
        sourceEventId: `issue-comment:${data.comment.id}:${data.action}`,
      });
      // immediate feedback (new comments DO live-update in open browsers)
      await replyToIssueComment(
        gateOctokit,
        { owner, repo, number: pr },
        `🔄 **Applying this fix…** — requested by @${data.sender.login}. Orvex will follow up here with the result.`,
      ).catch(() => {});
      return 'fix_enqueued_from_checkbox';
    }

    if (data.action !== 'created') return 'ignored_action';
    if (data.comment.user.login === githubConfig.botLogin) return 'own_comment';

    const command = parseOrvexCommand(data.comment.body);
    if (!command) return 'no_command';

    const owner = data.repository.owner.login;
    const repo = data.repository.name;
    const pr = data.issue.number;
    const installation = await resolveActiveInstallation(data, owner);
    if (!installation) return 'no_installation';

    const octokit = createInstallationOctokit(githubConfig, installation.installationId);

    const ref = { owner, repo, number: pr };
    if (!db.isRepoEnabled(installation.installationId, `${owner}/${repo}`)) {
      await replyToIssueComment(
        octokit,
        ref,
        'Orvex is disabled for this repository. Enable it in the Orvex dashboard to use commands.',
      ).catch(() => {});
      return 'repo_disabled';
    }

    // help is read-only (command list). rate_limit exposes plan/quota details, so
    // gate it like mutating commands. Everything else can commit or burn LLM quota.
    // Gate on real write access (not author_association, which counts read-only
    // org members as "write").
    const readOnlyCmd = command.kind === 'help';
    if (!readOnlyCmd && !(await userCanWrite(octokit, owner, repo, data.sender.login))) {
      return 'insufficient_permissions';
    }

    await addCommentReaction(octokit, owner, repo, data.comment.id, 'eyes', false);

    const requestedBy = data.sender.login;
    const sourceEventId = `issue-comment:${data.comment.id}:${data.action}`;
    const baseFix = { replyToCommentId: data.comment.id, isReviewComment: false, requestedBy, sourceEventId };

    switch (command.kind) {
      case 'review':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'review', undefined, { sourceEventId });
        return 'review_enqueued';
      case 'deep': {
        // PAID-ONLY: ~2x a normal review's cost — the free trial's whole point
        // is bounded spend, so it's excluded (plans.deepReviews).
        const features = planFeatures(db.getTenantPlan(installation.tenantId));
        if (!features.deepReviews) {
          await replyToIssueComment(
            octokit,
            { owner, repo, number: pr },
            '🔎 **Deep review** runs extra analysis passes and is available on paid plans. Upgrade at https://useorvex.com/#pricing — or use `@orvex review` for a standard re-review.',
          ).catch(() => {});
          return 'deep_not_in_plan';
        }
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'review', undefined, {
          deep: true,
          sourceEventId,
        });
        await replyToIssueComment(
          octokit,
          { owner, repo, number: pr },
          '🔎 **Deep review started** — running extra diverse analysis passes on top of the standard review. This takes noticeably longer than a normal review (often 10+ minutes), so no need to worry if it is not back in a couple of minutes. New findings will be added to this PR; nothing already found is repeated. A deep review counts as 2 reviews toward your monthly quota.',
        ).catch(() => {});
        return 'deep_enqueued';
      }
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
      case 'resolve_conflicts':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'resolve', { ...baseFix, scope: 'all' });
        return 'resolve_enqueued';
      case 'prompt':
        // free-form "@orvex <anything>" at PR level → agent answers or edits
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'ask', {
          ...baseFix,
          scope: 'all',
          instruction: command.instruction,
        });
        return 'ask_enqueued';
      case 'ignore_at': {
        // Suppress by location. This is the ONLY route to a manual-review
        // candidate: those are rendered in a collapsed table with no inline
        // comment, so `ignore` as a thread reply can never resolve them and
        // they reappeared on every push forever.
        const key = { installationId: installation.installationId, owner, repo, pr };
        const state = db.getState(key);
        const wanted = command.file.replace(/^[`'"]|[`'"]$/g, '');
        const matches = (f: { file: string; line?: number }) =>
          (f.file === wanted || f.file.endsWith(`/${wanted}`)) &&
          (command.line === undefined || f.line === command.line);
        const target =
          (state?.manualReview ?? []).find(matches) ?? (state?.findings ?? []).find(matches);
        if (!target) {
          await replyToIssueComment(
            octokit,
            ref,
            formatFixSkippedReply(
              `no Orvex finding matches \`${wanted}${command.line ? `:${command.line}` : ''}\` on this PR. ` +
                'Use the exact `file:line` shown in the review.',
            ),
          );
          return 'ignore_no_finding';
        }
        db.addSuppression({
          installationId: installation.installationId,
          owner,
          repo,
          fingerprint: target.fingerprint,
          ruleId: target.ruleId,
          suppressedBy: requestedBy,
        });
        if (state) {
          const still = state.findings.find((f) => f.fingerprint === target.fingerprint);
          if (still) still.status = 'ignored';
          state.manualReview = (state.manualReview ?? []).filter(
            (f) => f.fingerprint !== target.fingerprint,
          );
          db.saveState(state);
        }
        await replyToIssueComment(
          octokit,
          ref,
          `🙈 **Ignored** \`${target.file}${target.line ? `:${target.line}` : ''}\` — Orvex won't report this finding again on \`${owner}/${repo}\` (suppressed by @${requestedBy}).`,
        );
        return 'finding_ignored';
      }
      case 'fix_this':
      case 'ignore':
      case 'explain':
        await replyToIssueComment(
          octokit,
          ref,
          formatFixSkippedReply(
            `reply directly on one of Orvex's inline findings to use \`${commandTrigger()} fix this\`, \`ignore\`, or \`explain\` — ` +
              `or use \`${commandTrigger()} ignore <file>:<line>\` here to silence a manual-review candidate.`,
          ),
        );
        return 'needs_thread_context';
      case 'rate_limit': {
        const plan = planFeatures(db.getTenantPlan(installation.tenantId));
        const status = loadAccountQuotaStatus(db, owner, installation.tenantId, plan);
        await replyToIssueComment(octokit, ref, formatQuotaStatusComment(status, commandTrigger()));
        return 'rate_limit_posted';
      }
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

      // this path commits to the branch, so gate it on the toggler's write
      // access (there's no author_association on a bot-authored comment).
      const gateOctokit = createInstallationOctokit(githubConfig, installation.installationId);
      if (!db.isRepoEnabled(installation.installationId, `${owner}/${repo}`)) {
        await replyToReviewComment(
          gateOctokit,
          owner,
          repo,
          pr,
          data.comment.id,
          'Orvex is disabled for this repository. Enable it in the Orvex dashboard to use commands.',
        ).catch(() => {});
        return 'repo_disabled';
      }
      if (!(await userCanWrite(gateOctokit, owner, repo, data.sender.login))) {
        return 'insufficient_permissions';
      }

      await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
        scope: 'one',
        fingerprint,
        replyToCommentId: data.comment.id,
        isReviewComment: true,
        requestedBy: data.sender.login,
        sourceEventId: `review-comment:${data.comment.id}:${data.action}`,
      });

      // Immediate feedback that survives no-refresh: post a NEW reply comment
      // (GitHub live-updates new thread comments to open browsers, unlike an edit
      // to the bot's own comment which it does NOT push). The fix job then posts a
      // follow-up reply with the result + reason. This is why CodeRabbit feels
      // instant — status via new comments, not button edits.
      try {
        await replyToReviewComment(
          gateOctokit,
          owner,
          repo,
          pr,
          data.comment.id,
          `🔄 **Applying this fix…** Orvex is committing it to this branch — I'll post the result here in a moment.`,
        );
      } catch {
        /* best-effort progress signal — the fix is already enqueued */
      }
      // Also flip the checkbox to "⏳ Applying fix…" as a secondary signal (shows
      // on refresh, and the fix job resets it to a retry checkbox if it fails).
      try {
        await updateReviewCommentBody(
          gateOctokit,
          owner,
          repo,
          data.comment.id,
          replaceApplyLine(data.comment.body, applyingLine(fingerprint, data.sender.login)),
        );
      } catch {
        /* cosmetic — the fix is already enqueued */
      }
      return 'checkbox_fix_enqueued';
    }

    if (data.action !== 'created') return 'ignored_action';
    if (data.comment.user.login === githubConfig.botLogin) return 'own_comment';

    const command = parseOrvexCommand(data.comment.body);
    if (!command) return 'no_command';

    const installation = await resolveActiveInstallation(data, owner);
    if (!installation) return 'no_installation';

    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
    const threadRootId = data.comment.in_reply_to_id ?? data.comment.id;

    if (!db.isRepoEnabled(installation.installationId, `${owner}/${repo}`)) {
      await replyToReviewComment(
        octokit,
        owner,
        repo,
        pr,
        threadRootId,
        'Orvex is disabled for this repository. Enable it in the Orvex dashboard to use commands.',
      ).catch(() => {});
      return 'repo_disabled';
    }

    // help is read-only; rate_limit exposes plan/quota details — gate like mutations.
    // Other thread commands can commit or spend LLM.
    const readOnlyCmd = command.kind === 'help';
    if (!readOnlyCmd && !(await userCanWrite(octokit, owner, repo, data.sender.login))) {
      return 'insufficient_permissions';
    }

    await addCommentReaction(octokit, owner, repo, data.comment.id, 'eyes', true);

    // the thread root is Orvex's finding comment
    const requestedBy = data.sender.login;
    const sourceEventId = `review-comment:${data.comment.id}:${data.action}`;
    const baseFix = { replyToCommentId: threadRootId, isReviewComment: true, requestedBy, sourceEventId };

    switch (command.kind) {
      case 'review':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'review', undefined, { sourceEventId });
        return 'review_enqueued';
      case 'deep': {
        // PAID-ONLY: ~2x a normal review's cost — the free trial's whole point
        // is bounded spend, so it's excluded (plans.deepReviews).
        const features = planFeatures(db.getTenantPlan(installation.tenantId));
        if (!features.deepReviews) {
          await replyToIssueComment(
            octokit,
            { owner, repo, number: pr },
            '🔎 **Deep review** runs extra analysis passes and is available on paid plans. Upgrade at https://useorvex.com/#pricing — or use `@orvex review` for a standard re-review.',
          ).catch(() => {});
          return 'deep_not_in_plan';
        }
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'review', undefined, {
          deep: true,
          sourceEventId,
        });
        await replyToIssueComment(
          octokit,
          { owner, repo, number: pr },
          '🔎 **Deep review started** — running extra diverse analysis passes on top of the standard review. This takes noticeably longer than a normal review (often 10+ minutes), so no need to worry if it is not back in a couple of minutes. New findings will be added to this PR; nothing already found is repeated. A deep review counts as 2 reviews toward your monthly quota.',
        ).catch(() => {});
        return 'deep_enqueued';
      }
      case 'fix':
      case 'fix_this':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
          ...baseFix,
          scope: 'one',
        });
        return 'thread_fix_enqueued';
      case 'fix_all':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
          ...baseFix,
          scope: 'all',
        });
        return 'fix_all_enqueued';
      case 'prompt':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'fix', {
          ...baseFix,
          scope: 'one',
          instruction: command.instruction,
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
          ...baseFix,
          scope: 'one',
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
      case 'resolve_conflicts':
        await enqueueCommandJob(githubConfig, installation, owner, repo, pr, 'resolve', {
          ...baseFix,
          scope: 'all',
        });
        return 'resolve_enqueued';
      case 'rate_limit': {
        const plan = planFeatures(db.getTenantPlan(installation.tenantId));
        const status = loadAccountQuotaStatus(db, owner, installation.tenantId, plan);
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          pr,
          threadRootId,
          formatQuotaStatusComment(status, commandTrigger()),
        );
        return 'rate_limit_posted';
      }
      case 'help':
      default:
        await replyToReviewComment(octokit, owner, repo, pr, threadRootId, formatHelpComment(commandTrigger()));
        return 'help_posted';
    }
  }

  app.post(
    '/webhooks/github',
    // Cap the body BEFORE it's buffered — an unauthenticated attacker must not be
    // able to exhaust memory with a multi-GB POST before signature verification.
    // 25MB matches GitHub's own max webhook payload.
    bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (c) => c.json({ error: 'payload too large' }, 413) }),
    async (c) => {
    const githubConfig = getGithubConfig();
    const rawBody = await c.req.text();
    const signature = c.req.header('x-hub-signature-256');
    const event = c.req.header('x-github-event');

    if (!verifyWebhookSignature(githubConfig, rawBody, signature)) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    const deliveryId = c.req.header('x-github-delivery');
    // Require a delivery id after signature verify — without it we cannot claim
    // durably, and accepting the request would skip idempotency entirely.
    if (!deliveryId) {
      return c.json({ error: 'missing X-GitHub-Delivery' }, 400);
    }
    // AFTER signature verification, so a forged request can't poison the durable
    // claim. Failed processing releases the claim so GitHub can retry it.
    const deliveryClaim = db.claimWebhookEvent('github', deliveryId);
    if (!deliveryClaim) {
      const prior = db.getWebhookEvent('github', deliveryId);
      if (prior?.processedAt) return c.json({ ok: true, deduped: true });
      c.header('Retry-After', '5');
      return c.json({ error: 'delivery is already being processed' }, 503);
    }

    // Second key: body hash. Delivery-id alone is not enough — an attacker who
    // captured a valid signed payload can replay it with a new X-GitHub-Delivery.
    // GitHub's own retries reuse the same delivery id, so this only fires on
    // rotated-id replays (or rare identical payloads within the TTL window).
    const bodyHash = githubWebhookBodyHash(event, rawBody);
    const bodyProvider = db.webhookBodyProvider('github');
    const bodyClaim = db.claimWebhookBodyHash('github', bodyHash, { ttlMs: bodyHashTtlMs() });
    if (!bodyClaim) {
      db.releaseWebhookEvent('github', deliveryId, deliveryClaim);
      const prior = db.getWebhookEvent(bodyProvider, bodyHash);
      if (prior?.processedAt) return c.json({ ok: true, deduped: true, reason: 'body' });
      c.header('Retry-After', '5');
      return c.json({ error: 'payload is already being processed' }, 503);
    }

    let processingFailed = false;
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;

    if (event === 'installation') {
      const data = payload as unknown as InstallationWebhook;
      const inst = data.installation;
      if (!inst?.id) return c.json({ ok: true });

      if (data.action === 'deleted') {
        db.disableReposForInstallation(inst.id);
        const existing = db.getInstallation(inst.id);
        if (existing) {
          db.upsertInstallation({
            installationId: inst.id,
            tenantId: existing.tenantId,
            accountLogin: inst.account?.login ?? 'unknown',
            accountType: inst.account?.type ?? 'Organization',
            repositorySelection: inst.repository_selection ?? 'selected',
            suspendedAt: new Date().toISOString(),
          });
        }
        return c.json({ ok: true, action: 'deleted' });
      }

      const bound = await tenants.syncInstallationFromWebhook(inst.id, null, {
        accountLogin: inst.account?.login ?? 'unknown',
        accountType: inst.account?.type ?? 'Organization',
        repositorySelection: inst.repository_selection ?? 'selected',
        suspendedAt: inst.suspended_at ?? null,
      });

      // installation.created / .new_permissions_accepted carry a truncated
      // accessible-repo list (GitHub caps the webhook payload). Prefer the
      // truncated sync first, then — when the installation is already bound to
      // a tenant — pull the authoritative full list like the connect flow.
      syncReposFromPayload(
        inst.id,
        (payload as unknown as InstallationRepositoriesWebhook).repositories ?? [],
      );
      if (bound) {
        try {
          const repos = await listInstallationRepos(githubConfig, inst.id);
          syncReposFromPayload(
            inst.id,
            repos.map((r) => ({
              id: r.githubRepoId,
              name: r.name,
              full_name: r.fullName,
              private: r.private,
              default_branch: r.defaultBranch,
            })),
          );
        } catch (err) {
          console.warn(
            `[webhook] full installation repo sync failed for ${inst.id}:`,
            (err as Error).message,
          );
        }
      }

      console.log(`[webhook] installation ${data.action} id=${inst.id} account=${inst.account?.login}`);
      return c.json({ ok: true, action: data.action });
    }

    if (event === 'installation_repositories') {
      const data = payload as unknown as InstallationRepositoriesWebhook;
      const inst = data.installation;
      if (inst?.id) {
        for (const removed of data.repositories_removed ?? []) {
          db.disableRepoByGitHubId(inst.id, removed.id);
        }
        const added = data.repositories_added ?? [];
        syncReposFromPayload(inst.id, [
          ...added,
          ...(data.repositories ?? []),
        ]);
        // Removal sets enabled=0; upsert preserves that across resyncs so a
        // dashboard disable sticks. Re-adds must not stay stuck disabled forever —
        // apply autoEnableNewRepos as if the repo were newly granted.
        if (added.length > 0) {
          const installation = db.getInstallation(inst.id);
          if (installation) {
            const settings = db.getWorkspaceSettings(installation.tenantId);
            for (const r of added) {
              if (!r?.id) continue;
              const existing = db.getRepoByGitHubId(inst.id, r.id);
              if (existing) db.setRepoEnabled(existing.id, settings.autoEnableNewRepos);
            }
          }
        }
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
      // Log so checkbox/fix activity is observable (e.g. action=edited
      // outcome=checkbox_fix_enqueued when someone ticks the apply box).
      const action = (payload as { action?: string }).action;
      console.log(`[webhook] review_comment action=${action} outcome=${outcome}`);
      return c.json({ ok: true, outcome });
    }

    if (event !== 'pull_request') {
      return c.json({ ok: true, ignored: event ?? 'unknown' });
    }

    const prPayload = payload as unknown as PullRequestWebhook;
    const action = prPayload.action;

    // record lifecycle for open/close/merge/reopen/edit even when we don't re-review
    const LIFECYCLE_ACTIONS = new Set([...REVIEW_ACTIONS, 'closed', 'edited']);
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
    let prState: 'open' | 'closed' | 'merged' = prPayload.pull_request.merged
      ? 'merged'
      : action === 'closed' || prPayload.pull_request.state === 'closed'
        ? 'closed'
        : 'open';
    if (prState === 'closed' || prState === 'merged') {
      // A signed close event is normally authoritative, but deliveries can
      // arrive after a rapid reopen. Confirm current GitHub state before both
      // recording closure and terminating paid calls.
      try {
        if (
          await isPrStillOpen(
            createInstallationOctokit(githubConfig, installationId),
            { owner, repo, number: pr },
          )
        ) {
          prState = 'open';
          console.log(`[webhook] ignored delayed close event for reopened ${fullName}#${pr}`);
        }
      } catch (err) {
        // Fail toward the signed lifecycle event when GitHub is temporarily
        // unavailable; the worker's 5s poll remains the independent backstop.
        console.warn(`[webhook] could not confirm closed state for ${fullName}#${pr}:`, (err as Error).message);
      }
    }
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

    // Close any persisted Codex CLI session when the PR is done. The session
    // files are passive (no CPU), but deleting them keeps ~/.codex tidy.
    if (prState === 'closed' || prState === 'merged') {
      const cancelled = cancelActiveReviewsForPr({ installationId, owner, repo, pr });
      if (cancelled > 0) {
        console.warn(`[webhook] ${fullName}#${pr} closed — cancelled ${cancelled} active paid review(s)`);
      }
      const prior = db.getState({ installationId, owner, repo, pr });
      if (prior?.codexThreadId) {
        console.log(`[webhook] closing Codex session ${prior.codexThreadId} for ${owner}/${repo}#${pr}`);
        closeCodexSession(prior.codexThreadId).catch(() => {});
        db.saveState({ ...prior, codexThreadId: undefined });
      }
    }

    if (!REVIEW_ACTIONS.has(action)) {
      return c.json({ ok: true, recorded: prState, reviewed: false });
    }

    // Auto-apply loop guard: when Orvex's own auto-applied fix pushes a commit,
    // GitHub fires a `synchronize` whose sender is our bot. Re-reviewing that
    // would let review→fix→review bounce and burn the monthly budget on one PR.
    // A real author's push has a human/other sender and is reviewed normally.
    if (action === 'synchronize' && prPayload.sender?.login === githubConfig.botLogin) {
      console.log(`[webhook] ${fullName} synchronize from bot (own fix commit) — not re-reviewing`);
      return c.json({ ok: true, recorded: prState, reviewed: false, reason: 'own_commit' });
    }

    // respect the per-repo enable toggle from the dashboard
    if (!db.isRepoEnabled(installationId, fullName)) {
      console.log(`[webhook] ${fullName} disabled for review — recorded PR only`);
      return c.json({ ok: true, recorded: prState, reviewed: false, reason: 'repo_disabled' });
    }

    // respect the finer-grained "on open" vs "on push" toggles (dashboard
    // Settings section) — a repo can be enabled overall but opt out of one
    // trigger, e.g. review on open but not on every follow-up push.
    if (!db.isRepoActionEnabled(installationId, fullName, action)) {
      const which = action === 'synchronize' ? 'review_on_push' : 'review_on_open';
      console.log(`[webhook] ${fullName} ${action} skipped — ${which} is off`);
      return c.json({ ok: true, recorded: prState, reviewed: false, reason: which });
    }

    const job: ReviewJobPayload = {
      installationId,
      tenantId: installation.tenantId,
      owner,
      repo,
      pr,
      headSha,
      action: action as ReviewJobPayload['action'],
      priority: planFeatures(db.getTenantPlan(installation.tenantId)).priority,
      enqueuedAt: new Date().toISOString(),
    };

    const result = await queue.enqueue(job);
    console.log(
      `[webhook] tenant=${installation.tenantId.slice(0, 8)} inst=${installationId} ` +
        `${owner}/${repo}#${pr} ${action} @ ${headSha.slice(0, 7)} → ${result.reason ?? 'queued'}`,
    );

      return c.json({ ok: true, jobId: result.jobId, reason: result.reason });
    } catch (err) {
      processingFailed = true;
      throw err;
    } finally {
      if (bodyClaim) {
        if (processingFailed) db.releaseWebhookEvent(bodyProvider, bodyHash, bodyClaim);
        else db.completeWebhookEvent(bodyProvider, bodyHash, bodyClaim);
      }
      if (deliveryClaim) {
        if (processingFailed) db.releaseWebhookEvent('github', deliveryId, deliveryClaim);
        else db.completeWebhookEvent('github', deliveryId, deliveryClaim);
      }
    }
  });

  app.post('/review', async (c) => {
    const secret = process.env.REVIEW_API_SECRET;
    // Fail CLOSED: an unset secret used to leave this endpoint open to anyone,
    // who could trigger reviews and bind installations to a chosen workspace.
    if (!secret) return c.json({ error: 'endpoint disabled: REVIEW_API_SECRET not set' }, 503);
    const auth = c.req.header('authorization');
    const supplied = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!supplied || !safeEqualBearer(supplied, secret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const body = await c.req.json<{
      owner?: string;
      repo?: string;
      pr?: number;
      headSha?: string;
      repoSlug?: string;
      installationId?: number;
      tenantSlug?: string;
    }>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    let owner = body.owner;
    let repo = body.repo;
    if (body.repoSlug) {
      const [o, r] = body.repoSlug.split('/');
      owner = o;
      repo = r;
    }

    const pr = body.pr;
    if (
      !owner ||
      !repo ||
      typeof pr !== 'number' ||
      !Number.isSafeInteger(pr) ||
      pr < 1 ||
      (body.installationId !== undefined &&
        (!Number.isInteger(body.installationId) || body.installationId < 1))
    ) {
      return c.json({ error: 'owner, repo, pr required' }, 400);
    }

    const job = await enqueueManualReview(queue, {
      owner,
      repo,
      pr,
      headSha: body.headSha,
      installationId: body.installationId,
      tenantSlug: body.tenantSlug,
    }, db);

    return c.json({ ok: true, job });
  });

  // Admin: set a workspace's subscription plan. This is the billing/admin hook
  // that moves a tenant off the default 'review' plan onto 'verify' etc. — until
  // a real billing surface exists it lets plans be set without hand-editing the
  // DB. Guarded by the separate ORVEX_ADMIN_SECRET credential.
  app.post('/admin/tenants/:slug/plan', async (c) => {
    if (!authorizedAdminMutation(c, db)) return c.json({ error: 'unauthorized' }, 401);
    const { plan } = await c.req.json<{ plan?: string }>().catch(() => ({ plan: undefined }));
    if (!plan || !isPlanId(plan)) {
      return c.json({ error: 'plan is not a supported Orvex plan' }, 400);
    }
    const tenant = db.getTenantBySlug(c.req.param('slug'));
    if (!tenant) return c.json({ error: 'workspace not found' }, 404);
    db.setTenantPlan(tenant.id, plan);
    return c.json({ ok: true, slug: tenant.slug, plan });
  });

  return app;
}

function safeEqualBearer(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
