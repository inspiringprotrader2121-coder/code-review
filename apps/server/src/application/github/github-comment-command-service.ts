import {
  addCommentReaction,
  createInstallationOctokit,
  replyToIssueComment,
  replyToReviewComment,
  updateReviewCommentBody,
  userCanWrite,
  type GitHubAppConfig,
} from '@orvex-review/github';
import {
  applyCheckboxChecked,
  applyingLine,
  commandTrigger,
  formatAutoApplyReply,
  formatFixSkippedReply,
  formatHelpComment,
  parseApplyMarker,
  parseOrvexCommand,
  replaceApplyLine,
} from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { formatQuotaStatusComment, loadAccountQuotaStatus } from '../../quota-status.js';
import type { CommentWebhook } from './github-webhook-contracts.js';
import type { GitHubWebhookEventContext } from './github-webhook-event-context.js';

const DISABLED_MESSAGE =
  'Orvex is disabled for this repository. Enable it in the Orvex dashboard to use commands.';
const DEEP_UNAVAILABLE_MESSAGE =
  '🔎 **Deep review** runs extra analysis passes and is available on paid plans. Upgrade at https://useorvex.com/#pricing — or use `@orvex review` for a standard re-review.';
const DEEP_STARTED_MESSAGE =
  '🔎 **Deep review started** — running extra diverse analysis passes on top of the standard review. This takes noticeably longer than a normal review (often 10+ minutes), so no need to worry if it is not back in a couple of minutes. New findings will be added to this PR; nothing already found is repeated. A deep review counts as 2 reviews toward your monthly quota.';

/** Owns command parsing, permission admission, and command idempotency for both comment event shapes. */
export class GitHubCommentCommandService {
  constructor(private readonly context: GitHubWebhookEventContext) {}

  async handleIssueComment(githubConfig: GitHubAppConfig, data: CommentWebhook): Promise<string> {
    if (!data.issue?.pull_request) return 'not_a_pr';
    const owner = data.repository.owner.login;
    const repo = data.repository.name;
    const pr = data.issue.number;

    if (data.action === 'edited' && data.comment.user.login === githubConfig.botLogin) {
      return this.handleIssueCheckbox(githubConfig, data, owner, repo, pr);
    }
    if (data.action !== 'created') return 'ignored_action';
    if (data.comment.user.login === githubConfig.botLogin) return 'own_comment';
    const command = parseOrvexCommand(data.comment.body);
    if (!command) return 'no_command';

    const installation = await this.context.resolveActiveInstallation(data, owner);
    if (!installation) return 'no_installation';
    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
    const ref = { owner, repo, number: pr };
    if (!(await this.isEnabled(installation.installationId, owner, repo))) {
      await replyToIssueComment(octokit, ref, DISABLED_MESSAGE).catch(() => {});
      return 'repo_disabled';
    }
    if (command.kind !== 'help' && !(await userCanWrite(octokit, owner, repo, data.sender.login))) {
      return 'insufficient_permissions';
    }
    await addCommentReaction(octokit, owner, repo, data.comment.id, 'eyes', false);
    const sourceEventId = `issue-comment:${data.comment.id}:${data.action}`;
    const fix = {
      replyToCommentId: data.comment.id,
      isReviewComment: false,
      requestedBy: data.sender.login,
      sourceEventId,
    };
    const enqueue = (
      kind: 'review' | 'fix' | 'explain' | 'ask' | 'resolve',
      patch?: Record<string, unknown>,
    ) =>
      this.context.enqueueCommandJob(installation, owner, repo, pr, kind, patch as never, {
        sourceEventId,
      });

    switch (command.kind) {
      case 'review':
        await enqueue('review');
        return 'review_enqueued';
      case 'deep':
        if (!planFeatures(this.context.db.getTenantPlan(installation.tenantId)).deepReviews) {
          await replyToIssueComment(octokit, ref, DEEP_UNAVAILABLE_MESSAGE).catch(() => {});
          return 'deep_not_in_plan';
        }
        await this.context.enqueueCommandJob(installation, owner, repo, pr, 'review', undefined, {
          deep: true,
          sourceEventId,
        });
        await replyToIssueComment(octokit, ref, DEEP_STARTED_MESSAGE).catch(() => {});
        return 'deep_enqueued';
      case 'fix':
        await enqueue('fix', { ...fix, scope: 'ready' });
        return 'fix_enqueued';
      case 'fix_all':
        await enqueue('fix', { ...fix, scope: 'all' });
        return 'fix_all_enqueued';
      case 'auto_apply':
        this.context.db.setPrAutoApply(
          { installationId: installation.installationId, owner, repo, pr },
          command.enabled,
        );
        await replyToIssueComment(
          octokit,
          ref,
          formatAutoApplyReply(command.enabled, commandTrigger()),
        );
        if (command.enabled) await enqueue('fix', { ...fix, scope: 'ready' });
        return 'auto_apply_set';
      case 'resolve_conflicts':
        await enqueue('resolve', { ...fix, scope: 'all' });
        return 'resolve_enqueued';
      case 'prompt':
        await enqueue('ask', { ...fix, scope: 'all', instruction: command.instruction });
        return 'ask_enqueued';
      case 'ignore_at':
        return this.ignoreAtIssueComment(
          octokit,
          installation.installationId,
          owner,
          repo,
          pr,
          data.sender.login,
          command.file,
          command.line,
        );
      case 'fix_this':
      case 'ignore':
      case 'explain':
        await replyToIssueComment(
          octokit,
          ref,
          formatFixSkippedReply(
            `reply directly on one of Orvex's inline findings to use \`${commandTrigger()} fix this\`, \`ignore\`, or \`explain\` - ` +
              `or use \`${commandTrigger()} ignore <file>:<line>\` here to silence a manual-review candidate.`,
          ),
        );
        return 'needs_thread_context';
      case 'rate_limit': {
        const status = loadAccountQuotaStatus(
          this.context.db,
          owner,
          installation.tenantId,
          planFeatures(this.context.db.getTenantPlan(installation.tenantId)),
          this.context.config,
        );
        await replyToIssueComment(octokit, ref, formatQuotaStatusComment(status, commandTrigger()));
        return 'rate_limit_posted';
      }
      case 'help':
      default:
        await replyToIssueComment(octokit, ref, formatHelpComment(commandTrigger()));
        return 'help_posted';
    }
  }

  async handleReviewComment(githubConfig: GitHubAppConfig, data: CommentWebhook): Promise<string> {
    const owner = data.repository.owner.login;
    const repo = data.repository.name;
    const pr = data.pull_request?.number;
    if (!pr) return 'no_pr';
    if (data.action === 'edited' && data.comment.user.login === githubConfig.botLogin) {
      return this.handleReviewCheckbox(githubConfig, data, owner, repo, pr);
    }
    if (data.action !== 'created') return 'ignored_action';
    if (data.comment.user.login === githubConfig.botLogin) return 'own_comment';
    const command = parseOrvexCommand(data.comment.body);
    if (!command) return 'no_command';

    const installation = await this.context.resolveActiveInstallation(data, owner);
    if (!installation) return 'no_installation';
    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
    const threadRootId = data.comment.in_reply_to_id ?? data.comment.id;
    if (!(await this.isEnabled(installation.installationId, owner, repo))) {
      await replyToReviewComment(octokit, owner, repo, pr, threadRootId, DISABLED_MESSAGE).catch(
        () => {},
      );
      return 'repo_disabled';
    }
    if (command.kind !== 'help' && !(await userCanWrite(octokit, owner, repo, data.sender.login))) {
      return 'insufficient_permissions';
    }
    await addCommentReaction(octokit, owner, repo, data.comment.id, 'eyes', true);
    const sourceEventId = `review-comment:${data.comment.id}:${data.action}`;
    const fix = {
      replyToCommentId: threadRootId,
      isReviewComment: true,
      requestedBy: data.sender.login,
      sourceEventId,
    };
    const enqueue = (
      kind: 'review' | 'fix' | 'explain' | 'ask' | 'resolve',
      patch?: Record<string, unknown>,
    ) =>
      this.context.enqueueCommandJob(installation, owner, repo, pr, kind, patch as never, {
        sourceEventId,
      });

    switch (command.kind) {
      case 'review':
        await enqueue('review');
        return 'review_enqueued';
      case 'deep':
        if (!planFeatures(this.context.db.getTenantPlan(installation.tenantId)).deepReviews) {
          await replyToIssueComment(
            octokit,
            { owner, repo, number: pr },
            DEEP_UNAVAILABLE_MESSAGE,
          ).catch(() => {});
          return 'deep_not_in_plan';
        }
        await this.context.enqueueCommandJob(installation, owner, repo, pr, 'review', undefined, {
          deep: true,
          sourceEventId,
        });
        await replyToIssueComment(octokit, { owner, repo, number: pr }, DEEP_STARTED_MESSAGE).catch(
          () => {},
        );
        return 'deep_enqueued';
      case 'fix':
      case 'fix_this':
        await enqueue('fix', { ...fix, scope: 'one' });
        return 'thread_fix_enqueued';
      case 'fix_all':
        await enqueue('fix', { ...fix, scope: 'all' });
        return 'fix_all_enqueued';
      case 'prompt':
        await enqueue('fix', { ...fix, scope: 'one', instruction: command.instruction });
        return 'prompt_fix_enqueued';
      case 'ignore':
        return this.ignoreReviewComment(
          octokit,
          installation.installationId,
          owner,
          repo,
          pr,
          threadRootId,
          data.sender.login,
        );
      case 'explain':
        await enqueue('explain', { ...fix, scope: 'one' });
        return 'explain_enqueued';
      case 'auto_apply':
        this.context.db.setPrAutoApply(
          { installationId: installation.installationId, owner, repo, pr },
          command.enabled,
        );
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          pr,
          threadRootId,
          formatAutoApplyReply(command.enabled, commandTrigger()),
        );
        return 'auto_apply_set';
      case 'resolve_conflicts':
        await enqueue('resolve', { ...fix, scope: 'all' });
        return 'resolve_enqueued';
      case 'rate_limit': {
        const status = loadAccountQuotaStatus(
          this.context.db,
          owner,
          installation.tenantId,
          planFeatures(this.context.db.getTenantPlan(installation.tenantId)),
          this.context.config,
        );
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
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          pr,
          threadRootId,
          formatHelpComment(commandTrigger()),
        );
        return 'help_posted';
    }
  }

  private async handleIssueCheckbox(
    githubConfig: GitHubAppConfig,
    data: CommentWebhook,
    owner: string,
    repo: string,
    pr: number,
  ): Promise<string> {
    if (data.sender.login === githubConfig.botLogin) return 'own_edit';
    if (!applyCheckboxChecked(data.changes?.body?.from, data.comment.body)) return 'not_a_check';
    const fingerprint = parseApplyMarker(data.comment.body);
    if (!fingerprint) return 'no_marker';
    const installation = await this.context.resolveActiveInstallation(data, owner);
    if (!installation) return 'no_installation';
    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
    if (!(await this.isEnabled(installation.installationId, owner, repo))) {
      await replyToIssueComment(octokit, { owner, repo, number: pr }, DISABLED_MESSAGE).catch(
        () => {},
      );
      return 'repo_disabled';
    }
    if (!(await userCanWrite(octokit, owner, repo, data.sender.login)))
      return 'insufficient_permissions';
    await this.context.enqueueCommandJob(installation, owner, repo, pr, 'fix', {
      scope: 'one',
      fingerprint,
      replyToCommentId: data.comment.id,
      isReviewComment: false,
      requestedBy: data.sender.login,
      sourceEventId: `issue-comment:${data.comment.id}:${data.action}`,
    });
    await replyToIssueComment(
      octokit,
      { owner, repo, number: pr },
      `🔄 **Applying this fix…** — requested by @${data.sender.login}. Orvex will follow up here with the result.`,
    ).catch(() => {});
    return 'fix_enqueued_from_checkbox';
  }

  private async handleReviewCheckbox(
    githubConfig: GitHubAppConfig,
    data: CommentWebhook,
    owner: string,
    repo: string,
    pr: number,
  ): Promise<string> {
    if (data.sender.login === githubConfig.botLogin) return 'own_edit';
    if (!applyCheckboxChecked(data.changes?.body?.from, data.comment.body)) return 'not_a_check';
    const fingerprint = parseApplyMarker(data.comment.body);
    if (!fingerprint) return 'no_marker';
    const installation = await this.context.resolveActiveInstallation(data, owner);
    if (!installation) return 'no_installation';
    const octokit = createInstallationOctokit(githubConfig, installation.installationId);
    if (!(await this.isEnabled(installation.installationId, owner, repo))) {
      await replyToReviewComment(octokit, owner, repo, pr, data.comment.id, DISABLED_MESSAGE).catch(
        () => {},
      );
      return 'repo_disabled';
    }
    if (!(await userCanWrite(octokit, owner, repo, data.sender.login)))
      return 'insufficient_permissions';
    await this.context.enqueueCommandJob(installation, owner, repo, pr, 'fix', {
      scope: 'one',
      fingerprint,
      replyToCommentId: data.comment.id,
      isReviewComment: true,
      requestedBy: data.sender.login,
      sourceEventId: `review-comment:${data.comment.id}:${data.action}`,
    });
    await replyToReviewComment(
      octokit,
      owner,
      repo,
      pr,
      data.comment.id,
      `🔄 **Applying this fix…** Orvex is committing it to this branch — I'll post the result here in a moment.`,
    ).catch(() => {});
    await updateReviewCommentBody(
      octokit,
      owner,
      repo,
      data.comment.id,
      replaceApplyLine(data.comment.body, applyingLine(fingerprint, data.sender.login)),
    ).catch(() => {});
    return 'checkbox_fix_enqueued';
  }

  private async ignoreAtIssueComment(
    octokit: ReturnType<typeof createInstallationOctokit>,
    installationId: number,
    owner: string,
    repo: string,
    pr: number,
    requestedBy: string,
    file: string,
    line: number | undefined,
  ): Promise<string> {
    const key = { installationId, owner, repo, pr };
    const state = this.context.db.getState(key);
    const wanted = file.replace(/^[`'"]|[`'"]$/g, '');
    const matches = (finding: { file: string; line?: number }) =>
      (finding.file === wanted || finding.file.endsWith(`/${wanted}`)) &&
      (line === undefined || finding.line === line);
    const target = (state?.manualReview ?? []).find(matches) ?? state?.findings.find(matches);
    if (!target) {
      await replyToIssueComment(
        octokit,
        { owner, repo, number: pr },
        formatFixSkippedReply(
          `no Orvex finding matches \`${wanted}${line ? `:${line}` : ''}\` on this PR. Use the exact \`file:line\` shown in the review.`,
        ),
      );
      return 'ignore_no_finding';
    }
    this.context.db.addSuppression({
      installationId,
      owner,
      repo,
      fingerprint: target.fingerprint,
      ruleId: target.ruleId,
      suppressedBy: requestedBy,
    });
    if (state) {
      const finding = state.findings.find((item) => item.fingerprint === target.fingerprint);
      if (finding) finding.status = 'ignored';
      state.manualReview = (state.manualReview ?? []).filter(
        (item) => item.fingerprint !== target.fingerprint,
      );
      this.context.db.saveState(state);
    }
    await replyToIssueComment(
      octokit,
      { owner, repo, number: pr },
      `🙈 **Ignored** \`${target.file}${target.line ? `:${target.line}` : ''}\` — Orvex won't report this finding again on \`${owner}/${repo}\` (suppressed by @${requestedBy}).`,
    );
    return 'finding_ignored';
  }

  private async ignoreReviewComment(
    octokit: ReturnType<typeof createInstallationOctokit>,
    installationId: number,
    owner: string,
    repo: string,
    pr: number,
    threadRootId: number,
    requestedBy: string,
  ): Promise<string> {
    const state = this.context.db.getState({ installationId, owner, repo, pr });
    const finding = state?.findings.find((item) => item.githubCommentId === threadRootId);
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
    this.context.db.addSuppression({
      installationId,
      owner,
      repo,
      fingerprint: finding.fingerprint,
      ruleId: finding.ruleId,
      suppressedBy: requestedBy,
    });
    finding.status = 'ignored';
    if (state) this.context.db.saveState(state);
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

  private async isEnabled(installationId: number, owner: string, repo: string): Promise<boolean> {
    return this.context.db.isRepoEnabled(installationId, `${owner}/${repo}`);
  }
}
