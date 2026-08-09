import {
  createInstallationOctokit,
  fetchPrHeadInfo,
  mergeBranchInto,
  replyToIssueComment,
  replyToReviewComment,
} from '@orvex-review/github';
import type { FixRequest, ReviewJobPayload } from '@orvex-review/queue';
import { commandTrigger, formatFixSkippedReply } from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { commandPrecheck, completeCommandRun, reserveCommandRun } from './command-admission.js';
import type { AutofixDependencies, AutofixRuntime } from './contracts.js';

export async function processResolveJob(
  job: ReviewJobPayload,
  config: AutofixDependencies,
  runtime: AutofixRuntime,
): Promise<void> {
  const fix: FixRequest = job.fix ?? { scope: 'all' };
  const { installationId, owner, repo, pr } = job;
  const ref = { owner, repo, number: pr };
  const octokit = createInstallationOctokit(config.github, installationId);

  const reply = (body: string) =>
    fix.replyToCommentId && fix.isReviewComment
      ? replyToReviewComment(octokit, owner, repo, pr, fix.replyToCommentId, body)
      : replyToIssueComment(octokit, ref, body).then(() => undefined);

  // Paid gate: conflict resolution is an agentic write operation, paid plans only.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (!plan.autofix) {
    return void (await reply(
      formatFixSkippedReply(
        'conflict resolution is a paid feature — [upgrade](https://useorvex.com/#pricing).',
      ),
    ));
  }
  {
    const blocked = commandPrecheck(config, owner, plan.id, job.tenantId, runtime);
    if (blocked) {
      return void (await reply(formatFixSkippedReply(blocked)));
    }
  }
  const commandRunId = reserveCommandRun(config, job, 'resolve', plan.id, runtime);
  if (!commandRunId) {
    return void (await reply(
      formatFixSkippedReply(
        commandPrecheck(config, owner, plan.id, job.tenantId, runtime) ??
          `Orvex interactive commands are capped at ${runtime.autofix.commandsPerHour}/hour per account to prevent runaway cost — try again shortly.`,
      ),
    ));
  }
  const commandStartedAt = Date.now();
  let commandFinished = false;
  const finishCommand = (status: 'completed' | 'failed', error?: string) => {
    if (commandFinished) return;
    commandFinished = true;
    completeCommandRun(config, commandRunId, commandStartedAt, status, error);
  };

  try {
    const head = await fetchPrHeadInfo(octokit, ref);
    if (head.state !== 'open')
      return void (await reply(formatFixSkippedReply('this pull request is closed.')));
    if (!head.sameRepo) {
      return void (await reply(
        formatFixSkippedReply(`this PR is from a fork; Orvex can't update its branch.`),
      ));
    }
    if (head.mergeable === true && head.mergeableState !== 'behind') {
      return void (await reply(
        `✅ No merge conflicts to resolve — this PR is mergeable with \`${head.baseRef}\`.`,
      ));
    }

    try {
      if (config.leaseValid && !(await config.leaseValid())) {
        throw new Error(
          'review lease lost before conflict-resolution write; discarding this worker result',
        );
      }
      const result = await mergeBranchInto(octokit, owner, repo, head.ref, head.baseRef);
      if (result.status === 'up_to_date') {
        await reply(`✅ \`${head.ref}\` is already up to date with \`${head.baseRef}\`.`);
      } else if (result.status === 'merged') {
        await reply(
          `✅ **Conflicts resolved.** Merged \`${head.baseRef}\` into \`${head.ref}\` (\`${result.sha.slice(0, 7)}\`). Re-run \`${commandTrigger()} fix\` if you still want the review fixes applied.`,
        );
      } else {
        await reply(
          `⚠️ **Couldn't auto-resolve.** \`${head.ref}\` has overlapping changes with \`${head.baseRef}\` that need a human decision (git can't merge them safely, and Orvex won't guess at conflicting logic). Resolve those files manually, then comment \`${commandTrigger()} review\`.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'contents_write_denied') {
        await reply(
          formatFixSkippedReply(
            'Orvex needs `Contents: Read & write` accepted on the installation to update the branch.',
          ),
        );
      } else {
        throw err;
      }
    }
  } catch (err) {
    finishCommand('failed', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    finishCommand('completed');
  }
}
