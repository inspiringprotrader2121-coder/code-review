import {
  commitFilesAtomic,
  createInstallationOctokit,
  fetchBranchSha,
  fetchFileContent,
  fetchPrDiff,
  fetchPrHeadInfo,
  replyToIssueComment,
  replyToReviewComment,
} from '@orvex-review/github';
import type { FixRequest, ReviewJobPayload } from '@orvex-review/queue';
import {
  applyFixToContent,
  commandTrigger,
  formatFixSkippedReply,
  formatFixSummaryComment,
  runAgent,
  sanitizeFindingText,
  verifyFixes,
  type AgentFile,
} from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { isVerificationEnabled } from '../../verify-gate.js';
import { commandPrecheck, completeCommandRun, reserveCommandRun } from './command-admission.js';
import type { AutofixDependencies, AutofixRuntime } from './contracts.js';
import { SKIP_REASONS } from './target-selection.js';

export async function processAskJob(
  job: ReviewJobPayload,
  config: AutofixDependencies,
  runtime: AutofixRuntime,
): Promise<void> {
  const fix: FixRequest = job.fix ?? { scope: 'all' };
  const { installationId, owner, repo, pr } = job;
  const prKeyObj = { installationId, owner, repo, pr };
  const ref = { owner, repo, number: pr };
  const octokit = createInstallationOctokit(config.github, installationId);
  const instruction = fix.instruction ?? '';

  const reply = (body: string) =>
    fix.replyToCommentId && fix.isReviewComment
      ? replyToReviewComment(octokit, owner, repo, pr, fix.replyToCommentId, body)
      : replyToIssueComment(octokit, ref, body).then(() => undefined);

  // Paid gate: free trial gets automated reviews only; free-form `@orvex <ask>`
  // is an agentic LLM call reserved for paid plans.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (!plan.autofix) {
    return void (await reply(
      formatFixSkippedReply(
        'interactive `@orvex` commands are available on paid plans — your free trial includes automated reviews. [Upgrade](https://useorvex.com/#pricing).',
      ),
    ));
  }
  {
    const blocked = commandPrecheck(config, owner, plan.id, job.tenantId, runtime);
    if (blocked) {
      return void (await reply(formatFixSkippedReply(blocked)));
    }
  }
  const commandRunId = reserveCommandRun(config, job, 'ask', plan.id, runtime);
  if (!commandRunId) {
    return void (await reply(
      formatFixSkippedReply(
        commandPrecheck(config, owner, plan.id, job.tenantId, runtime) ??
          `Orvex interactive commands are capped at ${runtime.autofix.commandsPerHour}/hour per account to prevent runaway cost — try again shortly.`,
      ),
    ));
  }
  const commandUsage = config.createUsageRecorder(commandRunId, job.tenantId, 'ask');
  const commandStartedAt = Date.now();
  let commandFinished = false;
  const finishCommand = (status: 'completed' | 'failed', error?: string) => {
    if (commandFinished) return;
    commandFinished = true;
    completeCommandRun(config, commandRunId, commandStartedAt, status, error);
  };

  try {
    if (config.leaseValid && !(await config.leaseValid())) {
      throw new Error(
        'review lease lost before conflict-resolution write; discarding this worker result',
      );
    }
    const head = await fetchPrHeadInfo(octokit, ref);
    if (head.state !== 'open')
      return void (await reply(formatFixSkippedReply('this pull request is closed.')));

    // gather the PR's changed files with content as context
    const files = await fetchPrDiff(octokit, ref, {
      maxFileBytes: config.maxFileBytes,
      maxFiles: config.maxFiles,
      headSha: head.sha,
    });
    const agentFiles: AgentFile[] = [];
    for (const f of files) {
      if (f.status === 'removed') continue;
      const content = await fetchFileContent(octokit, owner, repo, f.filename, head.sha);
      if (content !== null) agentFiles.push({ path: f.filename, content });
    }

    const result = await runAgent(instruction, agentFiles, {
      apiKey: config.standardModel.apiKey,
      model: config.standardModel.model,
      baseUrl: config.standardModel.baseUrl,
      api: config.standardModel.api,
      reasoningEffort: config.standardModel.reasoningEffort,
      onUsage: commandUsage,
    });
    if (!result)
      return void (await reply(
        formatFixSkippedReply('could not process that request, try rephrasing.'),
      ));

    // Pure question → answer.
    if (result.mode === 'answer' || !result.changes || result.changes.length === 0) {
      await reply(`## Orvex\n\n${sanitizeFindingText(result.answer ?? 'Nothing to change.')}`);
      return;
    }

    // Change request → apply edits with the full safety stack.
    if (!head.sameRepo) {
      return void (await reply(
        formatFixSkippedReply(`this PR is from a fork; Orvex can't push changes here.`),
      ));
    }
    if (head.mergeable === false || head.mergeableState === 'dirty') {
      return void (await reply(
        formatFixSkippedReply(
          `this PR has merge conflicts with \`${head.baseRef}\` — resolve those first (\`${commandTrigger()} resolve conflicts\`), then ask again.`,
        ),
      ));
    }
    if (!config.store.acquireFixLock(prKeyObj, `ask:${job.enqueuedAt}`)) {
      return void (await reply(
        formatFixSkippedReply('another Orvex operation is already running on this PR.'),
      ));
    }
    try {
      const expectedHead = await fetchBranchSha(octokit, owner, repo, head.ref);
      const changes: Array<{ path: string; content: string }> = [];
      const applied: Array<{ file: string; message: string; sha: string }> = [];
      const skipped: Array<{ file: string; message: string; reason: string }> = [];

      // Read each file FRESH at expectedHead (never the agent's lagging snapshot —
      // that would revert a commit that landed during the multi-minute agent run).
      const freshContent = new Map<string, string>();
      const editList: Array<{ path: string; originalCode: string; fixedCode: string }> = [];
      const editsByFile = new Map<string, typeof result.changes>();
      const allowedAgentPaths = new Set(agentFiles.map((file) => file.path));
      for (const ch of result.changes) {
        if (!allowedAgentPaths.has(ch.file)) {
          skipped.push({
            file: ch.file,
            message: 'requested change',
            reason: 'the requested path was not part of the files supplied to the agent',
          });
          continue;
        }
        const list = editsByFile.get(ch.file) ?? [];
        list.push(ch);
        editsByFile.set(ch.file, list);
      }
      for (const [path, edits] of editsByFile) {
        const content = await fetchFileContent(octokit, owner, repo, path, expectedHead);
        if (content == null) {
          skipped.push({ file: path, message: 'requested change', reason: 'file not found' });
          continue;
        }
        freshContent.set(path, content);
        for (const ch of edits)
          editList.push({ path, originalCode: ch.originalCode, fixedCode: ch.fixedCode });
      }

      // Adversarial verify BEFORE committing — the ask path is the most powerful
      // arbitrary-edit surface and previously committed unverified. Drop any edit
      // the verifier can't confirm is a safe, correct application of the request.
      let approvedEdits = editList;
      if (editList.length > 0 && isVerificationEnabled(runtime)) {
        try {
          const { rejected } = await verifyFixes(
            editList.map((e) => ({
              file: e.path,
              findingMessage: `Requested change: ${instruction.slice(0, 200)}`,
              originalCode: e.originalCode,
              fixedCode: e.fixedCode,
            })),
            [...freshContent.entries()].map(([path, content]) => ({ path, content })),
            {
              apiKey: config.standardModel.apiKey,
              model: config.standardModel.model,
              baseUrl: config.standardModel.baseUrl,
              api: config.standardModel.api,
              reasoningEffort: config.standardModel.reasoningEffort,
              onUsage: commandUsage,
            },
          );
          const rej = new Set(rejected.map((r) => r.index));
          for (const r of rejected)
            skipped.push({
              file: editList[r.index]!.path,
              message: 'requested change',
              reason: 'change not verified as safe',
            });
          approvedEdits = editList.filter((_, i) => !rej.has(i));
        } catch (err) {
          console.warn(
            '[autofix] ask edit verification unavailable; refusing to commit:',
            (err as Error).message,
          );
          await reply(
            formatFixSkippedReply(
              'the requested edit could not be independently verified, so nothing was committed. Try again.',
            ),
          );
          return;
        }
      }

      // Apply approved edits per file (descending line order not needed — the ask
      // path re-anchors on exact originalCode substrings against fresh content).
      const changed = new Map<string, string>(freshContent);
      for (const e of approvedEdits) {
        const content = changed.get(e.path);
        if (content == null) continue;
        const res = applyFixToContent(content, {
          originalCode: e.originalCode,
          fixedCode: e.fixedCode,
        });
        if (res.ok) changed.set(e.path, res.content);
        else
          skipped.push({
            file: e.path,
            message: 'requested change',
            reason: SKIP_REASONS[res.reason],
          });
      }
      for (const [path, content] of changed) {
        if (content !== freshContent.get(path)) changes.push({ path, content });
      }

      if (changes.length === 0) {
        await reply(
          `## Orvex\n\n${sanitizeFindingText(result.summary ?? 'I could not safely apply that change.')}\n\n${
            skipped.length
              ? formatFixSummaryComment({ applied: [], skipped, headMoved: false })
              : ''
          }`,
        );
        return;
      }

      const coAuthor = fix.requestedBy
        ? `\nCo-authored-by: ${fix.requestedBy} <${fix.requestedBy}@users.noreply.github.com>`
        : '';
      const message = `chore: ${(result.summary ?? instruction).slice(0, 64)}\n\nRequested via @orvex by ${fix.requestedBy ?? 'a reviewer'}\n${coAuthor}`;
      try {
        if (config.leaseValid && !(await config.leaseValid())) {
          throw new Error('review lease lost before fix commit; discarding this worker result');
        }
        const commit = await commitFilesAtomic(
          octokit,
          owner,
          repo,
          head.ref,
          expectedHead,
          changes,
          message,
        );
        for (const ch of changes)
          applied.push({ file: ch.path, message: 'requested change', sha: commit.commitSha });
        await reply(
          `## Orvex\n\n${sanitizeFindingText(result.summary ?? 'Done.')}\n\n${formatFixSummaryComment({ applied, skipped, headMoved: false })}`,
        );
      } catch (err) {
        if (err instanceof Error && err.message === 'branch_moved') {
          await reply(
            formatFixSkippedReply(
              'the branch moved while I was working — nothing was committed. Ask again.',
            ),
          );
        } else if (err instanceof Error && err.message === 'contents_write_denied') {
          await reply(
            formatFixSkippedReply(
              'Orvex needs `Contents: Read & write` accepted on the installation to commit.',
            ),
          );
        } else {
          throw err;
        }
      }
    } finally {
      config.store.releaseFixLock(prKeyObj, `ask:${job.enqueuedAt}`);
    }
  } catch (err) {
    finishCommand('failed', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    finishCommand('completed');
  }
}
