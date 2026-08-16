import {
  createInstallationOctokit,
  isPrStillOpen,
  isRepoAllowed,
  type GitHubAppConfig,
} from '@orvex-review/github';
import { closeCodexSession } from '@orvex-review/review';
import { reviewJobAdmissionFields } from '@orvex-review/tenants';
import { cancelActiveReviewsForPr } from '../../active-reviews.js';
import type { GithubWebhookEventResult, PullRequestWebhook } from './github-webhook-contracts.js';
import type { GitHubWebhookEventContext } from './github-webhook-event-context.js';

const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
const LIFECYCLE_ACTIONS = new Set([...REVIEW_ACTIONS, 'closed', 'edited']);

/** Records every PR lifecycle event and admits at most one idempotent review job. */
export async function handlePullRequestEvent(
  context: GitHubWebhookEventContext,
  githubConfig: GitHubAppConfig,
  payload: PullRequestWebhook,
): Promise<GithubWebhookEventResult> {
  const action = payload.action;
  if (!LIFECYCLE_ACTIONS.has(action)) return { body: { ok: true, ignored: action } };

  const installationId = payload.installation?.id;
  if (!installationId)
    return { status: 400, body: { error: 'missing installation on pull_request event' } };
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pr = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;
  const fullName = payload.repository.full_name ?? `${owner}/${repo}`;

  if (githubConfig.allowedRepo && !isRepoAllowed(owner, repo, githubConfig.allowedRepo)) {
    console.log(`[webhook] ignored repo ${owner}/${repo} (legacy allowlist)`);
    return { body: { ok: true, ignored: 'repo' } };
  }
  const installation = await context.resolveActiveInstallation(payload, owner);
  if (!installation) return { body: { ok: true, ignored: 'suspended_or_unknown_installation' } };

  if (payload.repository.id && !context.db.getRepoByFullName(installationId, fullName)) {
    context.syncReposFromPayload(installationId, [
      {
        id: payload.repository.id,
        name: repo,
        full_name: fullName,
        private: payload.repository.private,
        default_branch: payload.repository.default_branch,
      },
    ]);
  }

  let state: 'open' | 'closed' | 'merged' = payload.pull_request.merged
    ? 'merged'
    : action === 'closed' || payload.pull_request.state === 'closed'
      ? 'closed'
      : 'open';
  if (state === 'closed' || state === 'merged') {
    try {
      if (
        await isPrStillOpen(createInstallationOctokit(githubConfig, installationId), {
          owner,
          repo,
          number: pr,
        })
      ) {
        state = 'open';
        console.log(`[webhook] ignored delayed close event for reopened ${fullName}#${pr}`);
      }
    } catch (error) {
      console.warn(
        `[webhook] could not confirm closed state for ${fullName}#${pr}:`,
        (error as Error).message,
      );
    }
  }
  context.db.upsertPullRequest({
    tenantId: installation.tenantId,
    installationId,
    repoFullName: fullName,
    number: pr,
    title: payload.pull_request.title ?? `#${pr}`,
    author: payload.pull_request.user?.login ?? 'unknown',
    state,
    draft: payload.pull_request.draft,
    headSha,
    url: payload.pull_request.html_url,
    openedAt: payload.pull_request.created_at ?? undefined,
    closedAt: payload.pull_request.closed_at ?? undefined,
    mergedAt: payload.pull_request.merged_at ?? undefined,
  });

  if (state === 'closed' || state === 'merged') {
    const cancelled = cancelActiveReviewsForPr({ installationId, owner, repo, pr });
    if (cancelled > 0)
      console.warn(
        `[webhook] ${fullName}#${pr} closed - cancelled ${cancelled} active paid review(s)`,
      );
    const prior = context.db.getState({ installationId, owner, repo, pr });
    if (prior?.codexThreadId) {
      console.log(
        `[webhook] closing Codex session ${prior.codexThreadId} for ${owner}/${repo}#${pr}`,
      );
      closeCodexSession(prior.codexThreadId).catch(() => {});
      context.db.saveState({ ...prior, codexThreadId: undefined });
    }
  }

  if (!REVIEW_ACTIONS.has(action)) return { body: { ok: true, recorded: state, reviewed: false } };
  if (action === 'synchronize' && payload.sender?.login === githubConfig.botLogin) {
    console.log(`[webhook] ${fullName} synchronize from bot (own fix commit) - not re-reviewing`);
    return { body: { ok: true, recorded: state, reviewed: false, reason: 'own_commit' } };
  }
  if (!context.db.isRepoEnabled(installationId, fullName)) {
    console.log(`[webhook] ${fullName} disabled for review - recorded PR only`);
    return { body: { ok: true, recorded: state, reviewed: false, reason: 'repo_disabled' } };
  }
  if (!context.db.isRepoActionEnabled(installationId, fullName, action)) {
    const reason = action === 'synchronize' ? 'review_on_push' : 'review_on_open';
    console.log(`[webhook] ${fullName} ${action} skipped - ${reason} is off`);
    return { body: { ok: true, recorded: state, reviewed: false, reason } };
  }

  const result = await context.queue.enqueue({
    installationId,
    tenantId: installation.tenantId,
    owner,
    repo,
    pr,
    headSha,
    action: action as 'opened' | 'synchronize' | 'reopened' | 'ready_for_review',
    ...reviewJobAdmissionFields(owner, context.db.getTenantPlan(installation.tenantId)),
    enqueuedAt: new Date().toISOString(),
  });
  console.log(
    `[webhook] tenant=${installation.tenantId.slice(0, 8)} inst=${installationId} ` +
      `${owner}/${repo}#${pr} ${action} @ ${headSha.slice(0, 7)} -> ${result.reason ?? 'queued'}`,
  );
  return { body: { ok: true, jobId: result.jobId, reason: result.reason } };
}
