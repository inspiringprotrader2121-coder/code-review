import {
  addCommentReaction,
  buildRepoContext,
  commitFilesAtomic,
  createInstallationOctokit,
  fetchBranchSha,
  fetchFileContent,
  fetchPrHeadInfo,
  replyToIssueComment,
  replyToReviewComment,
} from '@orvex-review/github';
import type { FixRequest, ReviewJobPayload } from '@orvex-review/queue';
import {
  applyFixToContent,
  commandTrigger,
  failedApplyLine,
  FixGenerationError,
  formatFixAppliedReply,
  formatFixSkippedReply,
  formatFixSummaryComment,
  verifyFindings,
  verifyFixes,
  type CodeFix,
  type ReviewFinding,
} from '@orvex-review/review';
import type { StoredFinding } from '@orvex-review/store';
import { planFeatures } from '@orvex-review/tenants';
import { isVerificationEnabled } from '../../verify-gate.js';
import { commandPrecheck, completeCommandRun, reserveCommandRun } from './command-admission.js';
import type { AutofixDependencies, AutofixRuntime, FixResult } from './contracts.js';
import { markApplyCheckboxDone, setApplyButtonState } from './github-publication.js';
import {
  isTransientGitHubError,
  resolveCodeFix,
  selectTargets,
  SKIP_REASONS,
} from './target-selection.js';

interface FixTarget {
  finding: StoredFinding;
}

export async function processFixJob(
  job: ReviewJobPayload,
  config: AutofixDependencies,
  runtime: AutofixRuntime,
): Promise<FixResult> {
  const fix: FixRequest = job.fix ?? { scope: 'ready' };
  const { installationId, owner, repo, pr } = job;
  const prKeyObj = { installationId, owner, repo, pr };
  const ref = { owner, repo, number: pr };
  const octokit = createInstallationOctokit(config.github, installationId);
  const startedAt = Date.now();
  let commandRunId: string | null = null;

  const respond = (body: string) =>
    fix.replyToCommentId && fix.isReviewComment
      ? replyToReviewComment(octokit, owner, repo, pr, fix.replyToCommentId, body)
      : replyToIssueComment(octokit, ref, body).then(() => undefined);

  // A ticked apply-checkbox was optimistically flipped to "⏳ Applying…" in the
  // webhook for instant feedback. EVERY exit below that doesn't commit must
  // revert it to a tickable retry checkbox — otherwise the button is stuck on
  // "Applying" forever (the recurring apply-fix bug). `skip()` does the revert +
  // the reply + the zero-result return in one call, so no gate can forget it.
  const skip = async (msg: string, buttonReason: string): Promise<FixResult> => {
    try {
      if (fix.isReviewComment && fix.replyToCommentId) {
        await setApplyButtonState(octokit, owner, repo, fix.replyToCommentId, (fp) =>
          failedApplyLine(fp, buttonReason),
        );
      }
      await respond(formatFixSkippedReply(msg));
      return { applied: 0, skipped: 0, headMoved: false };
    } finally {
      completeCommandRun(config, commandRunId, startedAt, 'skipped');
    }
  };

  // Plan gate: committing fixes (`@orvex fix`, apply-fix checkbox) is a paid
  // capability. Free-tier still gets findings + inline suggestions to apply by
  // hand, but Orvex won't push commits for them.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (!plan.autofix) {
    return skip(
      `committing fixes is available on paid plans. You can still apply the suggested change from the inline comment, or [upgrade](https://useorvex.com/#pricing) to let Orvex commit fixes for you.`,
      'paid plan required',
    );
  }

  const state = config.store.getState(prKeyObj);
  const openFindings = (state?.findings ?? []).filter((f) => f.status === 'open');
  if (openFindings.length === 0) {
    return skip(
      `no open Orvex findings on this PR. Run \`${commandTrigger()} review\` first.`,
      'no open findings',
    );
  }

  const head = await fetchPrHeadInfo(octokit, ref);
  if (head.state !== 'open') {
    return skip('this pull request is closed.', 'PR is closed');
  }
  if (!head.sameRepo) {
    return skip(
      `this PR comes from a fork (\`${head.headRepoFullName}\`), which Orvex cannot push to. Use the **Commit suggestion** buttons on the inline comments instead.`,
      'fork PR — cannot push',
    );
  }

  // merge-conflict guard: never apply fixes onto a branch with conflicts —
  // committing on top would entrench a broken merge and muddy the resolution.
  if (head.mergeable === false || head.mergeableState === 'dirty') {
    return skip(
      `this PR has **merge conflicts** with \`${head.baseRef}\`, so Orvex won't apply fixes on top of a conflicted branch. Resolve the conflicts (or comment \`${commandTrigger()} resolve conflicts\` to let Orvex try), then re-run \`${commandTrigger()} fix\`.`,
      'merge conflicts',
    );
  }

  // runaway guard: cap fix commits per PR per day
  const maxFixRuns = runtime.autofix.maxFixRunsPerDay;
  if (config.store.countRecentFixRuns(prKeyObj) >= maxFixRuns) {
    return skip(
      `this PR hit the auto-fix limit (${maxFixRuns} fix runs in 24 h). Apply the remaining fixes manually or raise ORVEX_MAX_FIX_RUNS_PER_DAY.`,
      'daily fix limit reached',
    );
  }

  commandRunId = reserveCommandRun(config, job, 'fix', plan.id, runtime);
  if (!commandRunId) {
    return skip(
      commandPrecheck(config, owner, plan.id, job.tenantId, runtime) ??
        `Orvex interactive commands are capped at ${runtime.autofix.commandsPerHour}/hour per account to prevent runaway cost — try again shortly.`,
      'interactive command limit reached',
    );
  }
  const commandUsage = config.createUsageRecorder(commandRunId, job.tenantId, 'autofix');

  // one fix operation per PR at a time — the concurrency guard, part 1
  const holder = `${job.enqueuedAt}:${fix.scope}`;
  if (!config.store.acquireFixLock(prKeyObj, holder)) {
    return skip(
      'another Orvex fix is already running on this PR — try again in a minute.',
      'another fix is running',
    );
  }

  try {
    // Cap the number of findings a single fix run acts on. `fix all` returns
    // EVERY open finding; each non-ready one triggers an LLM fix-generation call
    // plus verification, so an uncapped run on a many-finding PR is a large,
    // repeatable provider bill. Excess findings are handled on the next run.
    const MAX_FIX_TARGETS = runtime.autofix.maxFixTargets;
    const allTargets = selectTargets(openFindings, fix);
    const targets = allTargets.slice(0, MAX_FIX_TARGETS);
    if (allTargets.length > targets.length) {
      console.log(
        `[autofix] capping fix run to ${targets.length}/${allTargets.length} findings (ORVEX_MAX_FIX_TARGETS)`,
      );
    }
    if (targets.length === 0) {
      // still inside the lock's try — `skip` reverts the button; the finally
      // below releases the lock.
      return skip(
        fix.scope === 'one'
          ? 'could not match this thread to an open Orvex finding.'
          : `no findings with ready fixes. Try \`${commandTrigger()} fix all\` to let Orvex generate fixes.`,
        'no matching fix found',
      );
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

    // Cross-file context for LLM-generated fixes: the files the target code
    // imports, so generated fixes respect signatures/contracts elsewhere.
    const needsLlm =
      Boolean(fix.instruction) ||
      targets.some((t) => !(t.originalCode && t.fixedCode !== undefined));
    let relatedByFile = new Map<string, Array<{ path: string; content: string }>>();
    if (needsLlm && runtime.autofix.deepContext) {
      try {
        const ctx = await buildRepoContext(octokit, owner, repo, expectedHead, [...byFile.keys()], {
          maxSourceFiles: runtime.autofix.context.maxSourceFiles,
          maxRelated: runtime.autofix.context.maxRelated,
          maxDependents: runtime.autofix.context.maxDependents,
          maxFileBytes: runtime.autofix.context.maxFileBytes,
          maxOthers: runtime.autofix.context.maxOthers,
        });
        // give every target file the same repo-wide context set (they share a PR)
        const ctxFiles = [...ctx.related, ...ctx.dependents, ...ctx.others];
        relatedByFile = new Map([...byFile.keys()].map((f) => [f, ctxFiles]));
      } catch {
        // context is best-effort
      }
    }

    // Phase 1a: resolve a candidate fix per finding against pristine content.
    // Nothing is applied yet — candidates go through verification first.
    interface Candidate {
      file: string;
      finding: StoredFinding;
      codeFix: CodeFix;
    }
    const pristine = new Map<string, string>();
    const candidates: Candidate[] = [];
    for (const [file, fileTargets] of byFile) {
      let content: string | null;
      try {
        content = await fetchFileContent(octokit, owner, repo, file, expectedHead);
      } catch (err) {
        // P2-3: transient GitHub read errors must not be mislabeled "file missing".
        const transient = isTransientGitHubError(err);
        const reason = transient
          ? 'transient GitHub API error — try again'
          : `could not read file (${err instanceof Error ? err.message : String(err)})`;
        for (const t of fileTargets) {
          skipped.push({ file, message: t.finding.message, reason });
        }
        continue;
      }
      if (content === null) {
        for (const t of fileTargets) {
          skipped.push({ file, message: t.finding.message, reason: SKIP_REASONS.file_missing });
        }
        continue;
      }
      pristine.set(file, content);

      // VERIFY THE FINDING IS REAL before generating any fix. The finding passed
      // review-time verification, but a false positive that slipped through (or
      // was tier-rescued) must NOT cause the fixer to rewrite correct code — a
      // bad comment turning into a bad commit is the worst outcome. Re-check each
      // target against the CURRENT file with the strict verifier; drop any that
      // no longer hold. Bias is safe: a skipped real fix is a re-run away, but a
      // fix applied to a non-bug is a silent regression. ORVEX_VERIFY=0 disables
      // outside production; in production it is ignored unless FORCE_OFF=1.
      let confirmed = fileTargets;
      if (isVerificationEnabled(runtime) && fileTargets.length > 0) {
        try {
          const asFindings: ReviewFinding[] = fileTargets.map((t) => ({
            file: t.finding.file,
            line: t.finding.line,
            severity: t.finding.severity as ReviewFinding['severity'],
            category: t.finding.category,
            message: t.finding.message,
            suggestion: t.finding.suggestion,
            originalCode: t.finding.originalCode,
            fixedCode: t.finding.fixedCode,
            confidence: t.finding.confidence,
            ruleId: t.finding.ruleId,
          }));
          const { dropped } = await verifyFindings(asFindings, [{ path: file, content }], {
            apiKey: config.standardModel.apiKey,
            model: config.standardModel.model,
            baseUrl: config.standardModel.baseUrl,
            strict: true,
            onUsage: commandUsage,
          });
          if (dropped.length > 0) {
            const rejected = new Set(
              dropped.map((d) => `${d.finding.line ?? '?'}|${d.finding.message}`),
            );
            confirmed = fileTargets.filter((t) => {
              const bad = rejected.has(`${t.finding.line ?? '?'}|${t.finding.message}`);
              if (bad) {
                skipped.push({
                  file,
                  message: t.finding.message,
                  reason: 'finding not confirmed on re-check — not fixed (likely a false positive)',
                });
              }
              return !bad;
            });
            console.log(
              `[autofix] pre-fix finding verification dropped ${dropped.length}/${fileTargets.length} in ${file}`,
            );
          }
        } catch (err) {
          // Verifier unavailable → proceed (the fix-side verifyFixes still gates).
          console.warn(
            `[autofix] pre-fix finding verification skipped for ${file}:`,
            (err as Error).message,
          );
        }
      }

      for (const t of confirmed) {
        let codeFix: CodeFix | null;
        try {
          codeFix = await resolveCodeFix(
            t.finding,
            content,
            fix,
            config,
            relatedByFile.get(file),
            commandUsage,
          );
        } catch (err) {
          // P2-5: distinguish transient model failures from "no safe fix".
          if (err instanceof FixGenerationError) {
            const reason =
              err.kind === 'transient'
                ? 'LLM temporarily unavailable — try again'
                : err.kind === 'unparseable'
                  ? 'fix response was unparseable — try again'
                  : SKIP_REASONS.no_fix;
            skipped.push({ file, message: t.finding.message, reason });
            continue;
          }
          throw err;
        }
        if (!codeFix) {
          skipped.push({ file, message: t.finding.message, reason: SKIP_REASONS.no_fix });
          continue;
        }
        // validity pre-check against the CURRENT code (not the review-time code)
        const probe = applyFixToContent(content, codeFix);
        if (!probe.ok) {
          const alreadyFixed =
            probe.reason === 'not_found' &&
            codeFix.fixedCode.trim().length > 0 &&
            content.includes(codeFix.fixedCode.trim());
          skipped.push({
            file,
            message: t.finding.message,
            reason: alreadyFixed ? SKIP_REASONS.already_fixed : SKIP_REASONS[probe.reason],
          });
          if (alreadyFixed) t.finding.status = 'fixed';
          continue;
        }
        candidates.push({ file, finding: t.finding, codeFix });
      }
    }

    // Phase 1b: adversarial verification — a skeptical model call gates every
    // candidate against the full file before anything is committed.
    let approvedCandidates = candidates;
    if (candidates.length > 0 && isVerificationEnabled(runtime)) {
      const { approved, rejected } = await verifyFixes(
        candidates.map((c) => ({
          file: c.file,
          findingMessage: c.finding.message,
          originalCode: c.codeFix.originalCode,
          fixedCode: c.codeFix.fixedCode,
        })),
        [...pristine.entries()].map(([path, content]) => ({ path, content })),
        {
          apiKey: config.standardModel.apiKey,
          model: config.standardModel.model,
          baseUrl: config.standardModel.baseUrl,
          onUsage: commandUsage,
        },
      );
      for (const r of rejected) {
        const c = candidates[r.index];
        skipped.push({
          file: c.file,
          message: c.finding.message,
          reason: `failed verification — ${r.reason}`,
        });
      }
      approvedCandidates = approved.map((i) => candidates[i]);
      if (rejected.length > 0) {
        console.log(`[autofix] fix verification rejected ${rejected.length}/${candidates.length}`);
      }
    }

    // Phase 1c: apply approved fixes in memory, re-checking anchors as content mutates.
    const fileChanges: Array<{ path: string; content: string }> = [];
    const pendingFindings: StoredFinding[] = [];
    const working = new Map<string, string>(pristine);
    const touchedFiles = new Set<string>();
    // Apply within each file in DESCENDING line order, so an earlier edit never
    // shifts the line numbers a later same-file fix anchors on — otherwise a fix
    // whose `originalCode` occurs more than once could land on the wrong (stale)
    // occurrence, at a spot verifyFixes never approved. Cross-file order is
    // irrelevant; ties/unknown lines keep their relative order.
    const orderedCandidates = [...approvedCandidates].sort(
      (a, b) => (b.codeFix.line ?? 0) - (a.codeFix.line ?? 0),
    );
    for (const c of orderedCandidates) {
      const content = working.get(c.file);
      if (content === undefined) continue;
      const result = applyFixToContent(content, c.codeFix);
      if (!result.ok) {
        skipped.push({
          file: c.file,
          message: c.finding.message,
          reason: SKIP_REASONS[result.reason],
        });
        continue;
      }
      working.set(c.file, result.content);
      touchedFiles.add(c.file);
      pendingFindings.push(c.finding);
    }
    for (const file of touchedFiles) {
      fileChanges.push({ path: file, content: working.get(file)! });
    }

    // Phase 2: commit all changes atomically (all-or-nothing).
    let commitSha: string | null = null;
    if (fileChanges.length > 0) {
      if (config.leaseValid && !(await config.leaseValid())) {
        throw new Error('review lease lost before fix commit; discarding this worker result');
      }
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
            skipped.push({
              file: t.file,
              message: t.message,
              reason: 'branch moved — nothing applied',
            });
          }
        } else if (err instanceof Error && err.message === 'contents_write_denied') {
          permissionDenied = true;
          for (const t of pendingFindings) {
            skipped.push({
              file: t.file,
              message: t.message,
              reason: 'commit blocked — see note below',
            });
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

    // P1-2: revert the optimistic "⏳ Applying…" button BEFORE the summary reply.
    // If the reply itself throws, the catch below would still try to revert, but
    // doing it here means the normal path never leaves the button stuck either.
    if (fix.isReviewComment && fix.replyToCommentId && applied.length === 0) {
      const why = headMoved
        ? 'the branch moved'
        : permissionDenied
          ? 'commit permission needed'
          : (skipped[0]?.reason ?? 'could not apply');
      await setApplyButtonState(octokit, owner, repo, fix.replyToCommentId, (fp) =>
        failedApplyLine(fp, why),
      );
    }

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
    completeCommandRun(config, commandRunId, startedAt, 'completed');

    console.log(
      `[autofix] ${owner}/${repo}#${pr} scope=${fix.scope} applied=${applied.length} skipped=${skipped.length}${headMoved ? ' (head moved)' : ''}`,
    );

    return { applied: applied.length, skipped: skipped.length, headMoved };
  } catch (err) {
    completeCommandRun(
      config,
      commandRunId,
      startedAt,
      'failed',
      err instanceof Error ? err.message : String(err),
    );
    // P1-2: any unexpected throw must revert the optimistic "⏳ Applying…" button
    // back to a retry checkbox BEFORE we let the job fail; otherwise the button
    // is stuck forever. `skip()` handles its own revert, but non-skip throws
    // (GitHub API blips, commit failures, etc.) need this catch.
    if (fix.isReviewComment && fix.replyToCommentId) {
      const why = err instanceof Error ? err.message : 'unexpected error';
      await setApplyButtonState(octokit, owner, repo, fix.replyToCommentId, (fp) =>
        failedApplyLine(fp, why),
      );
    }
    throw err;
  } finally {
    config.store.releaseFixLock(prKeyObj, holder);
  }
}
