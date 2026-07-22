import {
  addCommentReaction,
  buildRepoContext,
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
  appliedLine,
  applyFixToContent,
  commandTrigger,
  failedApplyLine,
  FixGenerationError,
  formatFixAppliedReply,
  formatFixSkippedReply,
  formatFixSummaryComment,
  generateExplanationWithLlm,
  generateFixWithLlm,
  parseApplyMarker,
  replaceApplyLine,
  runAgent,
  verifyFindings,
  verifyFixes,
  type AgentFile,
  type CodeFix,
  type ReviewFinding,
} from '@orvex-review/review';
import type { StoredFinding } from '@orvex-review/store';
import { planFeatures } from '@orvex-review/tenants';
import type { WorkerConfig } from './pipeline.js';

export interface FixResult {
  applied: number;
  skipped: number;
  headMoved: boolean;
}

interface FixTarget {
  finding: StoredFinding;
}

/**
 * Generous per-account hourly ceiling on interactive `@orvex` commands
 * (explain / ask / resolve). These are paid-only LLM calls that the review cost
 * caps don't cover, so without this a single flat-fee account (or any
 * write-collaborator on it) could script thousands of `@orvex ask` calls into
 * unbounded provider spend. A real user never approaches this — it's a runaway
 * backstop, same idea as the review hourly ceiling.
 */
const COMMANDS_PER_HOUR = Math.max(1, Number(process.env.ORVEX_COMMANDS_PER_HOUR ?? 60));

/** True when this account has exhausted its hourly interactive-command budget. */
function commandOverRateLimit(store: WorkerConfig['store'], owner: string, planId: string): boolean {
  if (planId === 'enterprise') return false; // custom-contract tier
  return store.countAccountCommandRuns(owner, 3_600_000) >= COMMANDS_PER_HOUR;
}

/** Record an interactive command as a `cmd:*` run so it counts toward the
 *  hourly ceiling (and is excluded from the review caps). Reserved BEFORE the
 *  LLM call so concurrent commands see each other. */
function recordCommandRun(config: WorkerConfig, job: ReviewJobPayload, kind: string): void {
  config.store.recordReviewRun({
    tenantId: job.tenantId,
    installationId: job.installationId,
    owner: job.owner,
    repo: job.repo,
    pr: job.pr,
    headSha: job.headSha,
    action: `cmd:${kind}`,
    status: 'completed',
    durationMs: 0,
  });
}

const SKIP_REASONS: Record<string, string> = {
  not_found: `the code changed since the review — re-run \`${commandTrigger()} review\` first`,
  already_fixed: 'already fixed — the suggested change is already present in the file',
  ambiguous: 'the target code appears in several places and could not be located safely',
  noop: 'the fix is identical to the current code',
  no_fix: 'no safe fix could be generated',
  file_missing: 'the file no longer exists on the branch head',
};

function isTransientGitHubError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    return status === 429 || (typeof status === 'number' && status >= 500);
  }
  return false;
}

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

  // A ticked apply-checkbox was optimistically flipped to "⏳ Applying…" in the
  // webhook for instant feedback. EVERY exit below that doesn't commit must
  // revert it to a tickable retry checkbox — otherwise the button is stuck on
  // "Applying" forever (the recurring apply-fix bug). `skip()` does the revert +
  // the reply + the zero-result return in one call, so no gate can forget it.
  const skip = async (msg: string, buttonReason: string): Promise<FixResult> => {
    if (fix.isReviewComment && fix.replyToCommentId) {
      await setApplyButtonState(octokit, owner, repo, fix.replyToCommentId, (fp) =>
        failedApplyLine(fp, buttonReason),
      );
    }
    await respond(formatFixSkippedReply(msg));
    return { applied: 0, skipped: 0, headMoved: false };
  };

  // Plan gate: committing fixes (`@orvex fix`, apply-fix checkbox) is a paid
  // capability. Free-tier still gets findings + inline suggestions to apply by
  // hand, but Orvex won't push commits for them.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (!plan.autofix) {
    return skip(
      `committing fixes is available on paid plans. You can still apply the suggested change from the inline comment, or [upgrade](https://useorvex.com/pricing) to let Orvex commit fixes for you.`,
      'paid plan required',
    );
  }

  const state = config.store.getState(prKeyObj);
  const openFindings = (state?.findings ?? []).filter((f) => f.status === 'open');
  if (openFindings.length === 0) {
    return skip(`no open Orvex findings on this PR. Run \`${commandTrigger()} review\` first.`, 'no open findings');
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
  const maxFixRuns = Number(process.env.ORVEX_MAX_FIX_RUNS_PER_DAY ?? 30);
  if (config.store.countRecentFixRuns(prKeyObj) >= maxFixRuns) {
    return skip(
      `this PR hit the auto-fix limit (${maxFixRuns} fix runs in 24 h). Apply the remaining fixes manually or raise ORVEX_MAX_FIX_RUNS_PER_DAY.`,
      'daily fix limit reached',
    );
  }

  // one fix operation per PR at a time — the concurrency guard, part 1
  const holder = `${job.enqueuedAt}:${fix.scope}`;
  if (!config.store.acquireFixLock(prKeyObj, holder)) {
    return skip('another Orvex fix is already running on this PR — try again in a minute.', 'another fix is running');
  }

  try {
    // Cap the number of findings a single fix run acts on. `fix all` returns
    // EVERY open finding; each non-ready one triggers an LLM fix-generation call
    // plus verification, so an uncapped run on a many-finding PR is a large,
    // repeatable provider bill. Excess findings are handled on the next run.
    const MAX_FIX_TARGETS = Number(process.env.ORVEX_MAX_FIX_TARGETS ?? 25);
    const allTargets = selectTargets(openFindings, fix);
    const targets = allTargets.slice(0, MAX_FIX_TARGETS);
    if (allTargets.length > targets.length) {
      console.log(`[autofix] capping fix run to ${targets.length}/${allTargets.length} findings (ORVEX_MAX_FIX_TARGETS)`);
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
    if (needsLlm && process.env.ORVEX_DEEP_CONTEXT !== '0') {
      try {
        const ctx = await buildRepoContext(octokit, owner, repo, expectedHead, [...byFile.keys()], {
          maxSourceFiles: Number(process.env.ORVEX_CTX_SOURCE ?? 100),
          maxRelated: Number(process.env.ORVEX_CTX_RELATED ?? 30),
          maxDependents: Number(process.env.ORVEX_CTX_DEPENDENTS ?? 20),
          maxFileBytes: Number(process.env.ORVEX_CTX_FILE_BYTES ?? 32_000),
          maxOthers: Number(process.env.ORVEX_CTX_OTHERS ?? 20),
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
      // fix applied to a non-bug is a silent regression. ORVEX_VERIFY=0 disables.
      let confirmed = fileTargets;
      if (process.env.ORVEX_VERIFY !== '0' && fileTargets.length > 0) {
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
          });
          if (dropped.length > 0) {
            const rejected = new Set(dropped.map((d) => `${d.finding.line ?? '?'}|${d.finding.message}`));
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
            console.log(`[autofix] pre-fix finding verification dropped ${dropped.length}/${fileTargets.length} in ${file}`);
          }
        } catch (err) {
          // Verifier unavailable → proceed (the fix-side verifyFixes still gates).
          console.warn(`[autofix] pre-fix finding verification skipped for ${file}:`, (err as Error).message);
        }
      }

      for (const t of confirmed) {
        let codeFix: CodeFix | null;
        try {
          codeFix = await resolveCodeFix(t.finding, content, fix, config, relatedByFile.get(file));
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
    if (candidates.length > 0 && process.env.ORVEX_VERIFY !== '0') {
      const { approved, rejected } = await verifyFixes(
        candidates.map((c) => ({
          file: c.file,
          findingMessage: c.finding.message,
          originalCode: c.codeFix.originalCode,
          fixedCode: c.codeFix.fixedCode,
        })),
        [...pristine.entries()].map(([path, content]) => ({ path, content })),
        { apiKey: config.standardModel.apiKey, model: config.standardModel.model, baseUrl: config.standardModel.baseUrl },
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
        skipped.push({ file: c.file, message: c.finding.message, reason: SKIP_REASONS[result.reason] });
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

    // P1-2: revert the optimistic "⏳ Applying…" button BEFORE the summary reply.
    // If the reply itself throws, the catch below would still try to revert, but
    // doing it here means the normal path never leaves the button stuck either.
    if (fix.isReviewComment && fix.replyToCommentId && applied.length === 0) {
      const why = headMoved
        ? 'the branch moved'
        : permissionDenied
          ? 'commit permission needed'
          : (skipped[0]?.reason ?? 'could not apply');
      await setApplyButtonState(octokit, owner, repo, fix.replyToCommentId, (fp) => failedApplyLine(fp, why));
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

    console.log(
      `[autofix] ${owner}/${repo}#${pr} scope=${fix.scope} applied=${applied.length} skipped=${skipped.length}${headMoved ? ' (head moved)' : ''}`,
    );

    return { applied: applied.length, skipped: skipped.length, headMoved };
  } catch (err) {
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

  // Paid gate: `@orvex explain` is an LLM call. Like the other interactive
  // commands it's paid-only, so a free/trial account can't call it unmetered.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (!plan.autofix) {
    return void (await reply(
      formatFixSkippedReply(
        'explanations are available on paid plans — your free trial includes automated reviews. [Upgrade](https://useorvex.com/pricing).',
      ),
    ));
  }
  if (commandOverRateLimit(config.store, owner, plan.id)) {
    return void (await reply(
      formatFixSkippedReply(
        `Orvex interactive commands are capped at ${COMMANDS_PER_HOUR}/hour per account to prevent runaway cost — try again shortly.`,
      ),
    ));
  }
  recordCommandRun(config, job, 'explain');

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
    { apiKey: config.standardModel.apiKey, model: config.standardModel.model, baseUrl: config.standardModel.baseUrl },
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

  // Paid gate: free trial gets automated reviews only; free-form `@orvex <ask>`
  // is an agentic LLM call reserved for paid plans.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (!plan.autofix) {
    return void (await reply(
      formatFixSkippedReply(
        'interactive `@orvex` commands are available on paid plans — your free trial includes automated reviews. [Upgrade](https://useorvex.com/pricing).',
      ),
    ));
  }
  if (commandOverRateLimit(config.store, owner, plan.id)) {
    return void (await reply(
      formatFixSkippedReply(
        `Orvex interactive commands are capped at ${COMMANDS_PER_HOUR}/hour per account to prevent runaway cost — try again shortly.`,
      ),
    ));
  }
  recordCommandRun(config, job, 'ask');

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
    apiKey: config.standardModel.apiKey,
    model: config.standardModel.model,
    baseUrl: config.standardModel.baseUrl,
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
    const changes: Array<{ path: string; content: string }> = [];
    const applied: Array<{ file: string; message: string; sha: string }> = [];
    const skipped: Array<{ file: string; message: string; reason: string }> = [];

    // Read each file FRESH at expectedHead (never the agent's lagging snapshot —
    // that would revert a commit that landed during the multi-minute agent run).
    const freshContent = new Map<string, string>();
    const editList: Array<{ path: string; originalCode: string; fixedCode: string }> = [];
    const editsByFile = new Map<string, typeof result.changes>();
    for (const ch of result.changes) {
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
      for (const ch of edits) editList.push({ path, originalCode: ch.originalCode, fixedCode: ch.fixedCode });
    }

    // Adversarial verify BEFORE committing — the ask path is the most powerful
    // arbitrary-edit surface and previously committed unverified. Drop any edit
    // the verifier can't confirm is a safe, correct application of the request.
    let approvedEdits = editList;
    if (editList.length > 0 && process.env.ORVEX_VERIFY !== '0') {
      try {
        const { rejected } = await verifyFixes(
          editList.map((e) => ({
            file: e.path,
            findingMessage: `Requested change: ${instruction.slice(0, 200)}`,
            originalCode: e.originalCode,
            fixedCode: e.fixedCode,
          })),
          [...freshContent.entries()].map(([path, content]) => ({ path, content })),
          { apiKey: config.standardModel.apiKey, model: config.standardModel.model, baseUrl: config.standardModel.baseUrl },
        );
        const rej = new Set(rejected.map((r) => r.index));
        for (const r of rejected) skipped.push({ file: editList[r.index]!.path, message: 'requested change', reason: 'change not verified as safe' });
        approvedEdits = editList.filter((_, i) => !rej.has(i));
      } catch {
        /* verifier unavailable → proceed; the CAS commit still guards head moves */
      }
    }

    // Apply approved edits per file (descending line order not needed — the ask
    // path re-anchors on exact originalCode substrings against fresh content).
    const changed = new Map<string, string>(freshContent);
    for (const e of approvedEdits) {
      const content = changed.get(e.path);
      if (content == null) continue;
      const res = applyFixToContent(content, { originalCode: e.originalCode, fixedCode: e.fixedCode });
      if (res.ok) changed.set(e.path, res.content);
      else skipped.push({ file: e.path, message: 'requested change', reason: SKIP_REASONS[res.reason] });
    }
    for (const [path, content] of changed) {
      if (content !== freshContent.get(path)) changes.push({ path, content });
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

  // Paid gate: conflict resolution is an agentic write operation, paid plans only.
  const plan = planFeatures(config.store.getTenantPlan(job.tenantId));
  if (!plan.autofix) {
    return void (await reply(
      formatFixSkippedReply('conflict resolution is a paid feature — [upgrade](https://useorvex.com/pricing).'),
    ));
  }
  if (commandOverRateLimit(config.store, owner, plan.id)) {
    return void (await reply(
      formatFixSkippedReply(
        `Orvex interactive commands are capped at ${COMMANDS_PER_HOUR}/hour per account to prevent runaway cost — try again shortly.`,
      ),
    ));
  }
  recordCommandRun(config, job, 'resolve');

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
  relatedFiles?: Array<{ path: string; content: string }>,
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
      relatedFiles,
    },
    { apiKey: config.standardModel.apiKey, model: config.standardModel.model, baseUrl: config.standardModel.baseUrl },
  );
  return generated;
}

/** Flip the apply checkbox to done so it can't be re-triggered. */
/** Transition the apply-button comment to a new state (applied ✅ / failed).
 *  Anchored on the apply marker so it works whatever state the line is in
 *  (idle checkbox, "⏳ Applying…", etc.). */
async function setApplyButtonState(
  octokit: Parameters<typeof updateReviewCommentBody>[0],
  owner: string,
  repo: string,
  commentId: number,
  makeLine: (fingerprint: string) => string,
): Promise<void> {
  try {
    const comment = await getReviewComment(octokit, owner, repo, commentId);
    if (!comment) return;
    const fingerprint = parseApplyMarker(comment.body);
    if (!fingerprint) return;
    const updated = replaceApplyLine(comment.body, makeLine(fingerprint));
    if (updated !== comment.body) {
      await updateReviewCommentBody(octokit, owner, repo, commentId, updated);
    }
  } catch {
    // cosmetic — ignore failures
  }
}

function markApplyCheckboxDone(
  octokit: Parameters<typeof updateReviewCommentBody>[0],
  owner: string,
  repo: string,
  commentId: number,
  commitSha: string,
): Promise<void> {
  return setApplyButtonState(octokit, owner, repo, commentId, (fp) => appliedLine(fp, commitSha.slice(0, 7)));
}
