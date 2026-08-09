import {
  createInstallationOctokit,
  fetchFileContent,
  fetchPrHeadInfo,
  replyToIssueComment,
  replyToReviewComment,
} from '@orvex-review/github';
import type { FixRequest, ReviewJobPayload } from '@orvex-review/queue';
import {
  formatFixSkippedReply,
  generateExplanationWithLlm,
  sanitizeFindingText,
} from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { commandPrecheck, completeCommandRun, reserveCommandRun } from './command-admission.js';
import type { AutofixDependencies, AutofixRuntime } from './contracts.js';

export async function processExplainJob(
  job: ReviewJobPayload,
  config: AutofixDependencies,
  runtime: AutofixRuntime,
): Promise<void> {
  const fix: FixRequest = job.fix ?? { scope: 'one' };
  const { installationId, owner, repo, pr } = job;
  const octokit = createInstallationOctokit(config.github, installationId);

  const reply = (body: string) =>
    fix.replyToCommentId
      ? replyToReviewComment(octokit, owner, repo, pr, fix.replyToCommentId, body)
      : replyToIssueComment(octokit, { owner, repo, number: pr }, body).then(() => undefined);

  // Paid gate: `@orvex explain` is an LLM call. Like the other interactive
  // commands it's paid-only, so a free/trial account can't call it unmetered.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (!plan.autofix) {
    return void (await reply(
      formatFixSkippedReply(
        'explanations are available on paid plans — your free trial includes automated reviews. [Upgrade](https://useorvex.com/#pricing).',
      ),
    ));
  }
  {
    const blocked = commandPrecheck(config, owner, plan.id, job.tenantId, runtime);
    if (blocked) {
      return void (await reply(formatFixSkippedReply(blocked)));
    }
  }
  const commandRunId = reserveCommandRun(config, job, 'explain', plan.id, runtime);
  if (!commandRunId) {
    return void (await reply(
      formatFixSkippedReply(
        commandPrecheck(config, owner, plan.id, job.tenantId, runtime) ??
          `Orvex interactive commands are capped at ${runtime.autofix.commandsPerHour}/hour per account to prevent runaway cost — try again shortly.`,
      ),
    ));
  }
  const commandUsage = config.createUsageRecorder(commandRunId, job.tenantId, 'explain');
  const commandStartedAt = Date.now();
  let commandFinished = false;
  const finishCommand = (status: 'completed' | 'failed', error?: string) => {
    if (commandFinished) return;
    commandFinished = true;
    completeCommandRun(config, commandRunId, commandStartedAt, status, error);
  };
  try {
    const state = config.store.getState({ installationId, owner, repo, pr });
    const finding = (state?.findings ?? []).find(
      (f) =>
        (fix.fingerprint && f.fingerprint === fix.fingerprint) ||
        (fix.replyToCommentId && f.githubCommentId === fix.replyToCommentId),
    );
    if (!finding) {
      await reply(formatFixSkippedReply('could not match this thread to an Orvex finding.'));
      return;
    }

    const head = await fetchPrHeadInfo(octokit, { owner, repo, number: pr });
    const content = (await fetchFileContent(octokit, owner, repo, finding.file, head.sha)) ?? '';

    const explanation = await generateExplanationWithLlm(
      {
        filePath: finding.file,
        fileContent: content,
        findingMessage: finding.message,
        findingLine: finding.line,
        suggestion: finding.suggestion,
        severity: finding.severity,
      },
      {
        apiKey: config.standardModel.apiKey,
        model: config.standardModel.model,
        baseUrl: config.standardModel.baseUrl,
        api: config.standardModel.api,
        reasoningEffort: config.standardModel.reasoningEffort,
        onUsage: commandUsage,
      },
    );

    await reply(
      explanation
        ? sanitizeFindingText(explanation)
        : formatFixSkippedReply('could not generate an explanation, try again.'),
    );
  } catch (err) {
    finishCommand('failed', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    finishCommand('completed');
  }
}
