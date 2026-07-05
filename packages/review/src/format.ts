import type { ReviewFinding } from './finding.js';

export interface ReviewCommentMeta {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  stats?: { newCount: number; fixedCount: number; openCount: number };
  summary?: string;
  /** files Orvex read for this review (shown so a clean review isn't silent) */
  filesReviewed?: string[];
}

const MAX_FILES_LISTED = 25;

/** The categories every Orvex review inspects — shown so authors know the scope. */
const CHECKLIST = [
  'Security — auth/permission bypass, injection, SSRF/XSS, secrets in code',
  'Correctness — logic bugs, wrong conditions, off-by-one, unhandled cases',
  'Concurrency — race conditions, missing locks, unsafe shared state',
  'Error handling — swallowed errors, missing validation, edge cases',
  'Cross-file impact — callers/dependencies the change could break',
];

export function formatReviewBody(
  inline: ReviewFinding[],
  summaryOnly: ReviewFinding[],
  meta: ReviewCommentMeta,
): string {
  const shortSha = meta.headSha.slice(0, 7);
  const lines: string[] = [
    '## Orvex Review',
    '',
    `Reviewed \`${meta.owner}/${meta.repo}#${meta.pr}\` @ \`${shortSha}\`.`,
  ];

  if (meta.stats) {
    const { newCount, fixedCount, openCount } = meta.stats;
    lines.push(
      '',
      `**${newCount}** new · **${fixedCount}** fixed on this push · **${openCount}** still open`,
    );
  }

  if (meta.summary) {
    lines.push('', meta.summary);
  }

  // Files reviewed — so a clean review still shows exactly what was examined.
  if (meta.filesReviewed && meta.filesReviewed.length > 0) {
    const shown = meta.filesReviewed.slice(0, MAX_FILES_LISTED);
    const extra = meta.filesReviewed.length - shown.length;
    lines.push(
      '',
      `**Files reviewed (${meta.filesReviewed.length})**`,
      ...shown.map((f) => `- \`${f}\``),
      ...(extra > 0 ? [`- …and ${extra} more`] : []),
    );
  }

  const tableFindings = [...inline, ...summaryOnly];
  if (tableFindings.length === 0) {
    lines.push(
      '',
      '✅ **No issues found.** Nothing in this change looked unsafe or incorrect on this pass — it looks good to merge.',
    );
  } else {
    lines.push('', '| Severity | File | Message |', '| --- | --- | --- |');
    for (const f of tableFindings) {
      const file = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      const msg = f.message.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${f.severity} | ${file} | ${msg} |`);
    }

    const withSuggestions = tableFindings.filter((f) => f.suggestion);
    if (withSuggestions.length > 0) {
      lines.push('', '<details><summary>Suggestions</summary>', '');
      for (const f of withSuggestions) {
        lines.push(`**${f.file}** — ${f.message}`, '', f.suggestion!, '');
      }
      lines.push('</details>');
    }
  }

  // Always show what was checked for — turns a "0 findings" review into a
  // meaningful "here's what I verified" report instead of silence.
  lines.push(
    '',
    '<details><summary>What Orvex checked for</summary>',
    '',
    ...CHECKLIST.map((c) => `- ${c}`),
    '</details>',
  );

  return lines.join('\n');
}

export function formatFixedReply(shortSha: string): string {
  return `✅ Fixed on \`${shortSha}\` (verified on HEAD).`;
}

// ——— Interactive fix comments ———

const APPLY_MARKER_PREFIX = '<!--orvex:apply:';

export function applyMarker(fingerprint: string): string {
  return `${APPLY_MARKER_PREFIX}${fingerprint}-->`;
}

// A fingerprint is `v<version>-<16 hex>` (e.g. v2-a1b2c3d4e5f60718). Match the
// whole family — NOT just [a-f0-9]{16}, which silently fails on the `v2-` prefix
// and was the reason the apply-fix button never updated.
const FINGERPRINT_CHARS = '[a-zA-Z0-9_-]{6,64}';

/**
 * Matches the WHOLE line carrying an apply marker, in ANY state (unchecked
 * checkbox, checked, applying, applied, failed). The marker is the stable anchor
 * so the button can be transitioned between states regardless of its label.
 */
export const APPLY_LINE_RE = new RegExp(`^.*<!--orvex:apply:${FINGERPRINT_CHARS}-->.*$`, 'm');

/** The idle button line (an actionable task-list checkbox). */
export function applyCheckboxLine(fingerprint: string, hasFix: boolean): string {
  const label = hasFix ? 'Apply this fix' : 'Fix this with Orvex';
  return `- [ ] ${applyMarker(fingerprint)} **${label}** — Orvex commits to this PR branch`;
}

/** "⏳ Applying…" — shown immediately when the box is ticked, for instant feedback. */
export function applyingLine(fingerprint: string, requestedBy?: string): string {
  const by = requestedBy ? ` (requested by @${requestedBy})` : '';
  return `⏳ ${applyMarker(fingerprint)} **Applying fix…**${by}`;
}

/** "✅ Fix applied in <sha>" — the terminal success state on the button itself. */
export function appliedLine(fingerprint: string, shortSha: string): string {
  return `✅ ${applyMarker(fingerprint)} **Fix applied** in \`${shortSha}\``;
}

/** Failure state — re-offers the checkbox so the user can retry. */
export function failedApplyLine(fingerprint: string, reason: string): string {
  return `- [ ] ${applyMarker(fingerprint)} **Apply this fix** — last attempt failed (${reason}); tick to retry`;
}

/** Swap whichever apply-line the comment currently has for a new state line. */
export function replaceApplyLine(body: string, newLine: string): string {
  // Function replacement (not a string) so `$`-sequences in newLine — e.g. a
  // failure reason carrying LLM text with `$\`` / `$&` — are inserted literally
  // rather than interpreted as replacement patterns and corrupting the comment.
  return body.replace(APPLY_LINE_RE, () => newLine);
}

/** Extract the finding fingerprint from a comment carrying an apply checkbox. */
export function parseApplyMarker(body: string): string | null {
  const m = body.match(new RegExp(`<!--orvex:apply:(${FINGERPRINT_CHARS})-->`));
  return m ? m[1] : null;
}

/** True when an edit checked the apply checkbox (unchecked before, checked now). */
export function applyCheckboxChecked(bodyBefore: string | undefined, bodyAfter: string): boolean {
  const checkedNow = /- \[x\] <!--orvex:apply:/i.test(bodyAfter);
  if (!checkedNow) return false;
  if (bodyBefore === undefined) return true;
  return /- \[ \] <!--orvex:apply:/.test(bodyBefore);
}

export interface InlineFindingRender {
  finding: {
    severity: string;
    ruleId: string;
    message: string;
    suggestion?: string;
    originalCode?: string;
    fixedCode?: string;
    fingerprint: string;
  };
  /** trigger word shown in the footer, e.g. "@orvex" */
  trigger: string;
  /**
   * Whether this tenant's plan can commit fixes. When false (free trial), the
   * apply-checkbox is NOT rendered — ticking it would only hit the paid gate and
   * leave the button stuck on "Applying". Free tier still gets the inline
   * suggestion to apply by hand. Defaults to true (paid) for back-compat.
   */
  canAutofix?: boolean;
}

/**
 * Body for one inline finding comment:
 * - a native ```suggestion block (GitHub renders the diff preview and its own
 *   per-comment "Commit suggestion" button) when the fix replaces exactly the
 *   anchored line
 * - an Orvex apply-checkbox as the bot-side fix button
 * - footer with thread commands
 */
export function formatInlineFinding(r: InlineFindingRender): string {
  const f = r.finding;
  const parts = [`**${f.severity}** · \`${f.ruleId}\``, '', f.message];

  const fixedCode = f.fixedCode;
  const suggestionSafe =
    fixedCode !== undefined &&
    f.originalCode !== undefined &&
    !f.originalCode.includes('\n') &&
    !fixedCode.includes('```');

  if (suggestionSafe && fixedCode !== undefined) {
    parts.push('', '```suggestion', fixedCode, '```');
  } else if (f.suggestion) {
    parts.push('', f.suggestion);
  }

  if (r.canAutofix !== false) {
    // Offer the fix checkbox (paid plans). If no fix was pre-generated, Orvex
    // generates one on demand when the box is ticked (or `@orvex fix this`).
    parts.push('', applyCheckboxLine(f.fingerprint, fixedCode !== undefined));
    parts.push(
      '',
      `<sub>Tick the box above, or reply \`${r.trigger} fix this\` · \`${r.trigger} <instructions>\` for a custom fix · \`${r.trigger} explain\` · \`${r.trigger} ignore\`</sub>`,
    );
  } else {
    // Free trial: no commit-a-fix checkbox (that's paid) — the suggestion above
    // is applied by hand. Don't render a button that can only be rejected.
    parts.push(
      '',
      `<sub>Apply the suggested change above by hand, or [upgrade](https://useorvex.com/pricing) to let Orvex commit fixes · \`${r.trigger} ignore\` to dismiss.</sub>`,
    );
  }

  return parts.join('\n');
}

export function formatFixAppliedReply(shortSha: string, requestedBy?: string): string {
  const by = requestedBy ? ` (requested by @${requestedBy})` : '';
  return `✅ **Fix applied** in \`${shortSha}\`${by}.`;
}

export function formatFixSkippedReply(reason: string): string {
  return `⚠️ **Fix not applied** — ${reason}`;
}

export interface FixSummaryInput {
  applied: Array<{ file: string; message: string; sha: string }>;
  skipped: Array<{ file: string; message: string; reason: string }>;
  headMoved?: boolean;
}

export function formatFixSummaryComment(input: FixSummaryInput): string {
  const lines: string[] = ['## Orvex Fix'];
  if (input.applied.length > 0) {
    lines.push('', `Applied **${input.applied.length}** fix${input.applied.length === 1 ? '' : 'es'}:`);
    for (const a of input.applied) {
      lines.push(`- \`${a.file}\` — ${a.message} → \`${a.sha.slice(0, 7)}\``);
    }
  } else {
    lines.push('', 'No fixes were applied.');
  }
  if (input.skipped.length > 0) {
    lines.push('', `Skipped **${input.skipped.length}**:`);
    for (const s of input.skipped) {
      lines.push(`- \`${s.file}\` — ${s.message}: ${s.reason}`);
    }
  }
  if (input.headMoved) {
    lines.push(
      '',
      '> ⚠️ The branch got a new commit while Orvex was preparing these fixes, so **nothing was committed** — the fixes are applied all-at-once or not at all, and Orvex backed off to avoid overwriting the concurrent change. Re-run `@orvex fix` and it will pick up the new head.',
    );
  }
  return lines.join('\n');
}

export function formatAutoApplyReply(enabled: boolean, trigger: string): string {
  return enabled
    ? `🔁 **Auto-apply is ON** for this PR. Orvex will commit its ready fixes after each review — only fixes Orvex itself suggested, never other reviewers' comments. Turn off with \`${trigger} auto-apply off\`.`
    : `⏹ **Auto-apply is OFF** for this PR.`;
}

export function formatHelpComment(trigger: string): string {
  return [
    '## Orvex commands',
    '',
    `| Command | Effect |`,
    `| --- | --- |`,
    `| \`${trigger} review\` | Re-run the review on the current head |`,
    `| \`${trigger} fix\` | Apply all of Orvex's ready fix suggestions |`,
    `| \`${trigger} fix all\` | Apply ready fixes and AI-generate fixes for the remaining findings |`,
    `| \`${trigger} fix this\` | (reply on a finding) apply just that finding's fix |`,
    `| \`${trigger} <instructions>\` | (reply on a finding) AI fix following your instructions |`,
    `| \`${trigger} explain\` | (reply on a finding) deep-dive explanation of the issue |`,
    `| \`${trigger} ignore\` | (reply on a finding) never report this finding again on the repo |`,
    `| \`${trigger} resolve conflicts\` | Merge the base branch in to clear conflicts git can auto-resolve |`,
    `| \`${trigger} <anything>\` | Ask a question about the PR, or describe a change to make |`,
    `| \`${trigger} auto-apply on/off\` | Auto-commit Orvex's ready fixes after each future review of this PR |`,
    '',
    '<sub>Fixes are committed to the PR branch. Before committing, Orvex verifies the branch head has not moved and the target code is unchanged; if someone is editing concurrently, the fix is aborted rather than applied blindly.</sub>',
  ].join('\n');
}
