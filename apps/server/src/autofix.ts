import {
  addCommentReaction,
  commitFilesAtomic,
  createInstallationOctokit,
  fetchBranchSha,
  fetchFileContent,
  fetchPrDiff,
  fetchPrHeadInfo,
  getReviewComment,
  mergeBranchInto,
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
  runAgent,
  type AgentFile,
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
  already_fixed: 'already fixed — the suggested change is already present in the file',
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

  // merge-conflict guard: never apply fixes onto a branch with conflicts —
  // committing on top would entrench a broken merge and muddy the resolution.
  if (head.mergeable === false || head.mergeableState === 'dirty') {
    await respond(
      formatFixSkippedReply(
        `this PR has **merge conflicts** with \`${head.baseRef}\`, so Orvex won't apply fixes on top of a conflicted branch. Resolve the conflicts (or comment \`${commandTrigger()} resolve conflicts\` to let Orvex try), then re-run \`${commandTrigger()} fix\`.`,
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
    let headMoved = false;

    // The branch tip we anchor everything to. Read from the git ref (strongly
    // consistent) rather than the PR object (which lags), so we don't false-abort.
    // All files are read at this sha and the final commit's parent is this sha,
    // so the atomic ref update below is a true compare-and-swap: any concurrent
    // push makes the whole thing fail cleanly rather than half-applying.
    const expectedHead = await fetchBranchSha(octokit, owner, repo, head.ref);

    const byFile = new Map<string, FixTarget[]>();
    for (const finding of targets) {
      const list = byFile.get(finding.file) ?? [];
      list.push({ finding });
      byFile.set(finding.file, list);
    }

    // Phase 1: build every file change in memory. No writes yet.
    const fileChanges: Array<{ path: string; content: string }> = [];
    const pendingFindings: StoredFinding[] = [];
    for (const [file, fileTargets] of byFile) {
      let content = await fetchFileContent(octokit, owner, repo, file, expectedHead);
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
          // If the target snippet is gone but the replacement is already there,
          // the issue was fixed already — report that, don't call it "changed".
          const alreadyFixed =
            result.reason === 'not_found' &&
            codeFix.fixedCode.trim().length > 0 &&
            content.includes(codeFix.fixedCode.trim());
          const reason = alreadyFixed ? SKIP_REASONS.already_fixed : SKIP_REASONS[result.reason];
          skipped.push({ file, message: t.finding.message, reason });
          if (alreadyFixed) {
            // reconcile store state: this finding is resolved
            t.finding.status = 'fixed';
          }
          continue;
        }
        content = result.content;
        appliedHere.push(t.finding);
      }
      if (appliedHere.length > 0) {
        fileChanges.push({ path: file, content });
        pendingFindings.push(...appliedHere);
      }
    }

    // Phase 2: commit all changes atomically (all-or-nothing).
    let commitSha: string | null = null;
    if (fileChanges.length > 0) {
      const lead = pendingFindings[0].message;
      const coAuthor = fix.requestedBy
        ? `\nCo-authored-by: ${fix.requestedBy} <${fix.requestedBy}@users.noreply.github.com>`
        : '';
      const commitMessage =
        `fix: ${lead.slice(0, 60)}${pendingFindings.length > 1 ? ` (+${pendingFindings.length - 1} more)` : ''}` +
        `\n\nApplied by Orvex Review${fix.requestedBy ? ` for @${fix.requestedBy}` : ''}\n${coAuthor}`;

      try {
        const commit = await commitFilesAtomic(
          octokit,
          owner,
          repo,
          head.ref,
          expectedHead,
          fileChanges,
          commitMessage,
        );
        commitSha = commit.commitSha;
      } catch (err) {
        if (err instanceof Error && err.message === 'branch_moved') {
          headMoved = true;
          for (const t of pendingFindings) {
            skipped.push({ file: t.file, message: t.message, reason: 'branch moved — nothing applied' });
          }
        } else if (err instanceof Error && err.message === 'contents_write_denied') {
          permissionDenied = true;
          for (const t of pendingFindings) {
            skipped.push({ file: t.file, message: t.message, reason: 'commit blocked — see note below' });
          }
        } else {
          throw err;
        }
      }
    }

    // Phase 3: on success, mark findings fixed and reply on their comments.
    if (commitSha) {
      const shortSha = commitSha;
      for (const finding of pendingFindings) {
        applied.push({ file: finding.file, message: finding.message, sha: shortSha });
        finding.status = 'fixed';
        finding.fixedAtSha = shortSha;
        if (finding.githubCommentId) {
          try {
            await replyToReviewComment(
              octokit,
              owner,
              repo,
              pr,
              finding.githubCommentId,
              formatFixAppliedReply(shortSha.slice(0, 7), fix.requestedBy),
            );
            await markApplyCheckboxDone(octokit, owner, repo, finding.githubCommentId, shortSha);
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
      headSha: commitSha ?? expectedHead,
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

/** `@orvex <free-form instruction>` at PR level — answer a question or make a change. */
export async function processAskJob(job: ReviewJobPayload, config: WorkerConfig): Promise<void> {
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

  const head = await fetchPrHeadInfo(octokit, ref);
  if (head.state !== 'open') return void (await reply(formatFixSkippedReply('this pull request is closed.')));

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
    apiKey: config.llmApiKey,
    model: config.llmModel,
    baseUrl: config.llmBaseUrl,
  });
  if (!result) return void (await reply(formatFixSkippedReply('could not process that request, try rephrasing.')));

  // Pure question → answer.
  if (result.mode === 'answer' || !result.changes || result.changes.length === 0) {
    await reply(`## Orvex\n\n${result.answer ?? 'Nothing to change.'}`);
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
    return void (await reply(formatFixSkippedReply('another Orvex operation is already running on this PR.')));
  }
  try {
    const expectedHead = await fetchBranchSha(octokit, owner, repo, head.ref);
    const byPath = new Map<string, string>(agentFiles.map((f) => [f.path, f.content]));
    const changes: Array<{ path: string; content: string }> = [];
    const applied: Array<{ file: string; message: string; sha: string }> = [];
    const skipped: Array<{ file: string; message: string; reason: string }> = [];

    const editsByFile = new Map<string, typeof result.changes>();
    for (const ch of result.changes) {
      const list = editsByFile.get(ch.file) ?? [];
      list.push(ch);
      editsByFile.set(ch.file, list);
    }
    for (const [path, edits] of editsByFile) {
      let content = byPath.get(path) ?? (await fetchFileContent(octokit, owner, repo, path, expectedHead));
      if (content == null) {
        skipped.push({ file: path, message: 'requested change', reason: 'file not found' });
        continue;
      }
      let touched = false;
      for (const ch of edits) {
        const res = applyFixToContent(content, { originalCode: ch.originalCode, fixedCode: ch.fixedCode });
        if (res.ok) {
          content = res.content;
          touched = true;
        } else {
          skipped.push({ file: path, message: 'requested change', reason: SKIP_REASONS[res.reason] });
        }
      }
      if (touched) changes.push({ path, content });
    }

    if (changes.length === 0) {
      await reply(
        `## Orvex\n\n${result.summary ?? 'I could not safely apply that change.'}\n\n${
          skipped.length ? formatFixSummaryComment({ applied: [], skipped, headMoved: false }) : ''
        }`,
      );
      return;
    }

    const coAuthor = fix.requestedBy
      ? `\nCo-authored-by: ${fix.requestedBy} <${fix.requestedBy}@users.noreply.github.com>`
      : '';
    const message = `chore: ${(result.summary ?? instruction).slice(0, 64)}\n\nRequested via @orvex by ${fix.requestedBy ?? 'a reviewer'}\n${coAuthor}`;
    try {
      const commit = await commitFilesAtomic(octokit, owner, repo, head.ref, expectedHead, changes, message);
      for (const ch of changes) applied.push({ file: ch.path, message: 'requested change', sha: commit.commitSha });
      await reply(
        `## Orvex\n\n${result.summary ?? 'Done.'}\n\n${formatFixSummaryComment({ applied, skipped, headMoved: false })}`,
      );
    } catch (err) {
      if (err instanceof Error && err.message === 'branch_moved') {
        await reply(formatFixSkippedReply('the branch moved while I was working — nothing was committed. Ask again.'));
      } else if (err instanceof Error && err.message === 'contents_write_denied') {
        await reply(formatFixSkippedReply('Orvex needs `Contents: Read & write` accepted on the installation to commit.'));
      } else {
        throw err;
      }
    }
  } finally {
    config.store.releaseFixLock(prKeyObj, `ask:${job.enqueuedAt}`);
  }
}

/** `@orvex resolve conflicts` — merge the base branch in to clear conflicts git can auto-resolve. */
export async function processResolveJob(job: ReviewJobPayload, config: WorkerConfig): Promise<void> {
  const fix: FixRequest = job.fix ?? { scope: 'all' };
  const { installationId, owner, repo, pr } = job;
  const ref = { owner, repo, number: pr };
  const octokit = createInstallationOctokit(config.github, installationId);

  const reply = (body: string) =>
    fix.replyToCommentId && fix.isReviewComment
      ? replyToReviewComment(octokit, owner, repo, pr, fix.replyToCommentId, body)
      : replyToIssueComment(octokit, ref, body).then(() => undefined);

  const head = await fetchPrHeadInfo(octokit, ref);
  if (head.state !== 'open') return void (await reply(formatFixSkippedReply('this pull request is closed.')));
  if (!head.sameRepo) {
    return void (await reply(formatFixSkippedReply(`this PR is from a fork; Orvex can't update its branch.`)));
  }
  if (head.mergeable === true && head.mergeableState !== 'behind') {
    return void (await reply(`✅ No merge conflicts to resolve — this PR is mergeable with \`${head.baseRef}\`.`));
  }

  try {
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
      await reply(formatFixSkippedReply('Orvex needs `Contents: Read & write` accepted on the installation to update the branch.'));
    } else {
      throw err;
    }
  }
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
