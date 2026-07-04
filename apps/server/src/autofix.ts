import {
  addCommentReaction,
  commitFileUpdate,
  createInstallationOctokit,
  fetchFileContent,
  fetchBranchSha,
  fetchPrHeadInfo,
  getReviewComment,
  replyToIssueComment,
  replyToReviewComment,
  updateReviewCommentBody,
} from '@orvex-review/github';
import type { ReviewJobPayload, FixRequest } from '@orvex-review/queue';
import {
  applyFixToContent,
  commandTrigger,
  formatFixAppliedReply,
  formatFixSkippedReply,
  formatFixSummaryComment,
  generateExplanationWithLlm,
  generateFixWithLlm,
  type CodeFix,
} from '@orvex-review/review';
import type { StoredFinding } from '@orvex-review/store';
import type { WorkerConfig } from './pipeline.js';

export interface FixResult {
  applied: number;
  skipped: number;
  headMoved: boolean;
}

interface FixTarget {
  finding: StoredFinding;
}

const SKIP_REASONS: Record<string, string> = {
  not_found: `the code changed since the review — re-run \`${commandTrigger()} review\` first`,
  ambiguous: 'the target code appears in several places and could not be located safely',
  noop: 'the fix is identical to the current code',
  no_fix: 'no safe fix could be generated',
  file_missing: 'the file no longer exists on the branch head',
};

export async function processFixJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<FixResult> {
  const fix: FixRequest = job.fix ?? { scope: 'ready' };
  const { installationId, owner, repo, pr } = job;
  const prKeyObj = { installationId, owner, repo, pr };
  const ref = { owner, repo, number: pr };
  const octokit = createInstallationOctokit(config.github, installationId);
  const startedAt = Date.now();

  const respond = (body: string) =>
    fix.replyToCommentId && fix.isReviewComment
      ? replyToReviewComment(octokit, owner, repo, pr, fix.replyToCommentId, body)
      : replyToIssueComment(octokit, ref, body).then(() => undefined);

  const state = config.store.getState(prKeyObj);
  const openFindings = (state?.findings ?? []).filter((f) => f.status === 'open');
  if (openFindings.length === 0) {
    await respond(
      formatFixSkippedReply(
        `no open Orvex findings on this PR. Run \`${commandTrigger()} review\` first.`,
      ),
    );
    return { applied: 0, skipped: 0, headMoved: false };
  }

  const head = await fetchPrHeadInfo(octokit, ref);
  if (head.state !== 'open') {
    await respond(formatFixSkippedReply('this pull request is closed.'));
    return { applied: 0, skipped: 0, headMoved: false };
  }
  if (!head.sameRepo) {
    await respond(
      formatFixSkippedReply(
        `this PR comes from a fork (\`${head.headRepoFullName}\`), which Orvex cannot push to. Use the **Commit suggestion** buttons on the inline comments instead.`,
      ),
    );
    return { applied: 0, skipped: 0, headMoved: false };
  }

  // runaway guard: cap fix commits per PR per day
  const maxFixRuns = Number(process.env.ORVEX_MAX_FIX_RUNS_PER_DAY ?? 30);
  if (config.store.countRecentFixRuns(prKeyObj) >= maxFixRuns) {
    await respond(
      formatFixSkippedReply(
        `this PR hit the auto-fix limit (${maxFixRuns} fix runs in 24 h). Apply the remaining fixes manually or raise ORVEX_MAX_FIX_RUNS_PER_DAY.`,
      ),
    );
    return { applied: 0, skipped: 0, headMoved: false };
  }

  // one fix operation per PR at a time — the concurrency guard, part 1
  const holder = `${job.enqueuedAt}:${fix.scope}`;
  if (!config.store.acquireFixLock(prKeyObj, holder)) {
    await respond(
      formatFixSkippedReply('another Orvex fix is already running on this PR — try again in a minute.'),
    );
    return { applied: 0, skipped: 0, headMoved: false };
  }

  try {
    const targets = selectTargets(openFindings, fix);
    if (targets.length === 0) {
      await respond(
        formatFixSkippedReply(
          fix.scope === 'one'
            ? 'could not match this thread to an open Orvex finding.'
            : `no findings with ready fixes. Try \`${commandTrigger()} fix all\` to let Orvex generate fixes.`,
        ),
      );
      return { applied: 0, skipped: 0, headMoved: false };
    }

    const applied: Array<{ file: string; message: string; sha: string }> = [];
    const skipped: Array<{ file: string; message: string; reason: string }> = [];
    let permissionDenied = false;
    let expectedHead = head.sha;
    let headMoved = false;

    const byFile = new Map<string, FixTarget[]>();
    for (const finding of targets) {
      const list = byFile.get(finding.file) ?? [];
      list.push({ finding });
      byFile.set(finding.file, list);
    }

    for (const [file, fileTargets] of byFile) {
      if (headMoved) {
        for (const t of fileTargets) {
          skipped.push({ file, message: t.finding.message, reason: 'branch moved — aborted' });
        }
        continue;
      }

      // concurrency guard, part 2: did an EXTERNAL push land while we worked?
      // read the branch ref (strongly consistent) so Orvex's own prior commit
      // in this same run doesn't count as an external move.
      const branchSha = await fetchBranchSha(octokit, owner, repo, head.ref);
      if (branchSha !== expectedHead) {
        headMoved = true;
        for (const t of fileTargets) {
          skipped.push({ file, message: t.finding.message, reason: 'branch moved — aborted' });
        }
        continue;
      }

      let content = await fetchFileContent(octokit, owner, repo, file, head.ref);
      if (content === null) {
        for (const t of fileTargets) {
          skipped.push({ file, message: t.finding.message, reason: SKIP_REASONS.file_missing });
        }
        continue;
      }

      const appliedHere: StoredFinding[] = [];
      for (const t of fileTargets) {
        const codeFix = await resolveCodeFix(t.finding, content, fix, config);
        if (!codeFix) {
          skipped.push({ file, message: t.finding.message, reason: SKIP_REASONS.no_fix });
          continue;
        }
        const result = applyFixToContent(content, codeFix);
        if (!result.ok) {
          skipped.push({ file, message: t.finding.message, reason: SKIP_REASONS[result.reason] });
          continue;
        }
        content = result.content;
        appliedHere.push(t.finding);
      }

      if (appliedHere.length === 0) continue;

      const first = appliedHere[0].message;
      const coAuthor = fix.requestedBy
        ? `\nCo-authored-by: ${fix.requestedBy} <${fix.requestedBy}@users.noreply.github.com>`
        : '';
      const commitMessage =
        `fix: ${first.slice(0, 60)}${appliedHere.length > 1 ? ` (+${appliedHere.length - 1} more)` : ''}` +
        `\n\nApplied by Orvex Review${fix.requestedBy ? ` for @${fix.requestedBy}` : ''}\n${coAuthor}`;

      let commitSha: string;
      try {
        const commit = await commitFileUpdate(
          octokit,
          owner,
          repo,
          head.ref,
          file,
          content,
          commitMessage,
        );
        commitSha = commit.commitSha;
      } catch (err) {
        // concurrency guard, part 3: GitHub rejected because the file changed under us
        if (err instanceof Error && err.message === 'concurrent_update') {
          headMoved = true;
          for (const t of appliedHere) {
            skipped.push({ file, message: t.message, reason: 'file edited concurrently — aborted' });
          }
          continue;
        }
        // permission not yet accepted — report clearly instead of crashing the job
        if (err instanceof Error && err.message === 'contents_write_denied') {
          permissionDenied = true;
          for (const t of appliedHere) {
            skipped.push({ file, message: t.message, reason: 'commit blocked — see note below' });
          }
          break;
        }
        throw err;
      }

      expectedHead = commitSha;

      for (const finding of appliedHere) {
        applied.push({ file, message: finding.message, sha: commitSha });
        finding.status = 'fixed';
        finding.fixedAtSha = commitSha;

        if (finding.githubCommentId) {
          try {
            await replyToReviewComment(
              octokit,
              owner,
              repo,
              pr,
              finding.githubCommentId,
              formatFixAppliedReply(commitSha.slice(0, 7), fix.requestedBy),
            );
            await markApplyCheckboxDone(octokit, owner, repo, finding.githubCommentId, commitSha);
          } catch (err) {
            console.warn(`[autofix] could not reply on comment ${finding.githubCommentId}:`, err);
          }
        }
      }
    }

    if (state) {
      config.store.saveState(state);
    }

    const permissionNote = permissionDenied
      ? `\n\n> ⚠️ **Orvex can't commit yet.** The GitHub App has \`Contents: Read & write\`, but this installation is still on the old permissions. An org/account owner must **accept the updated permissions** at **Settings → Applications → Orvex Review → Review request** (or https://github.com/settings/installations). Once accepted, ticking the box or \`${commandTrigger()} fix\` will commit automatically.`
      : '';

    // Per-thread single fixes already replied inline; command-level runs get a summary.
    const singleInlineReply =
      fix.scope === 'one' && applied.length === 1 && skipped.length === 0 && !permissionDenied;
    if (!singleInlineReply) {
      const summary = formatFixSummaryComment({ applied, skipped, headMoved }) + permissionNote;
      if (fix.scope === 'one' && fix.replyToCommentId && fix.isReviewComment) {
        await replyToReviewComment(octokit, owner, repo, pr, fix.replyToCommentId, summary);
      } else {
        await replyToIssueComment(octokit, ref, summary);
      }
    }

    if (fix.replyToCommentId) {
      await addCommentReaction(
        octokit,
        owner,
        repo,
        fix.replyToCommentId,
        applied.length > 0 ? 'rocket' : 'confused',
        Boolean(fix.isReviewComment),
      );
    }

    config.store.recordReviewRun({
      tenantId: job.tenantId,
      installationId,
      owner,
      repo,
      pr,
      headSha: expectedHead,
      action: `fix:${fix.scope}`,
      status: 'completed',
      durationMs: Date.now() - startedAt,
      findingsFixed: applied.length,
      findingsOpen: openFindings.length - applied.length,
    });

    console.log(
      `[autofix] ${owner}/${repo}#${pr} scope=${fix.scope} applied=${applied.length} skipped=${skipped.length}${headMoved ? ' (head moved)' : ''}`,
    );

    return { applied: applied.length, skipped: skipped.length, headMoved };
  } finally {
    config.store.releaseFixLock(prKeyObj, holder);
  }
}

/** `@orvex explain` — post a deep-dive explanation as a thread reply. */
export async function processExplainJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<void> {
  const fix: FixRequest = job.fix ?? { scope: 'one' };
  const { installationId, owner, repo, pr } = job;
  const octokit = createInstallationOctokit(config.github, installationId);

  const reply = (body: string) =>
    fix.replyToCommentId
      ? replyToReviewComment(octokit, owner, repo, pr, fix.replyToCommentId, body)
      : replyToIssueComment(octokit, { owner, repo, number: pr }, body).then(() => undefined);

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
    { apiKey: config.llmApiKey, model: config.llmModel, baseUrl: config.llmBaseUrl },
  );

  await reply(explanation ?? formatFixSkippedReply('could not generate an explanation, try again.'));
}

function selectTargets(open: StoredFinding[], fix: FixRequest): StoredFinding[] {
  if (fix.scope === 'one') {
    const byFingerprint = fix.fingerprint
      ? open.filter((f) => f.fingerprint === fix.fingerprint)
      : [];
    if (byFingerprint.length > 0) return byFingerprint;
    if (fix.replyToCommentId) {
      return open.filter((f) => f.githubCommentId === fix.replyToCommentId);
    }
    return [];
  }
  if (fix.scope === 'ready') {
    return open.filter((f) => f.originalCode && f.fixedCode !== undefined);
  }
  return [...open]; // 'all'
}

async function resolveCodeFix(
  finding: StoredFinding,
  fileContent: string,
  fix: FixRequest,
  config: WorkerConfig,
): Promise<CodeFix | null> {
  // custom instruction always regenerates, even when a ready fix exists
  if (!fix.instruction && finding.originalCode && finding.fixedCode !== undefined) {
    return { originalCode: finding.originalCode, fixedCode: finding.fixedCode, line: finding.line };
  }
  const generated = await generateFixWithLlm(
    {
      filePath: finding.file,
      fileContent,
      findingMessage: finding.message,
      findingLine: finding.line,
      suggestion: finding.suggestion,
      instruction: fix.instruction,
    },
    { apiKey: config.llmApiKey, model: config.llmModel, baseUrl: config.llmBaseUrl },
  );
  return generated;
}

/** Flip the apply checkbox to done so it can't be re-triggered. */
async function markApplyCheckboxDone(
  octokit: Parameters<typeof updateReviewCommentBody>[0],
  owner: string,
  repo: string,
  commentId: number,
  commitSha: string,
): Promise<void> {
  try {
    const comment = await getReviewComment(octokit, owner, repo, commentId);
    if (!comment || !comment.body.includes('<!--orvex:apply:')) return;
    const updated = comment.body.replace(
      /- \[[ x]\] (<!--orvex:apply:[a-f0-9]{16}-->) \*\*Apply fix\*\*[^\n]*/i,
      `✅ $1 **Fix applied** in \`${commitSha.slice(0, 7)}\``,
    );
    if (updated !== comment.body) {
      await updateReviewCommentBody(octokit, owner, repo, commentId, updated);
    }
  } catch {
    // cosmetic — ignore failures
  }
}
