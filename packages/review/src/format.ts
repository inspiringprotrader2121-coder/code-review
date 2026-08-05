import type { ReviewFinding, ReviewSurfaceFinding } from './finding.js';
import { formatReviewCommandsFooter } from './commands-catalog.js';

export interface ReviewCommentMeta {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  stats?: { newCount: number; fixedCount: number; openCount: number };
  summary?: string;
  /** files Orvex read for this review (shown so a clean review isn't silent) */
  filesReviewed?: string[];
  /** true when this run included the extra `@orvex deep` passes */
  isDeep?: boolean;
  /** findings from EARLIER reviews still open on this commit — listed so a
   *  re-run on the same commit reports the full result set, not just the delta
   *  (a re-run that says "0 new" with no list reads as "found nothing") */
  stillOpen?: Array<{ severity: string; file: string; line?: number; message: string }>;
  /** command trigger (e.g. "@orvex") — shown in the one-click "fix all" box */
  trigger?: string;
  /** true when this tenant's plan can commit fixes — gates the "fix all" box */
  canAutofix?: boolean;
  /** set ONLY when the PR was NOT fully reviewed — Orvex must never claim a clean
   *  "looks good to merge" when part of the change never reached the model. */
  coverage?: { reviewed: number; candidates: number; skippedByCap: number; truncatedFiles: number; omittedPatch?: number };
  /** lens/pass names that did NOT complete (best-effort passes are allowed to fail
   *  without aborting the review — but the review must SAY SO. A Verify badge that
   *  reads "no issues found" while one of its promised reviewers never ran is a
   *  false assurance the customer paid for.) */
  skippedLenses?: string[];
  /** Candidate findings that are intentionally shown for manual review instead
   * of posted inline or treated as confirmed open findings. */
  reviewOnly?: ReviewSurfaceFinding[];
  /** Set when the precision verification gate did not complete successfully. */
  verificationIncomplete?: string;
}

const MAX_FILES_LISTED = 25;
/**
 * Hard cap on manual-review rows. This table is the ONLY unbounded section of
 * the review body: the file list is capped at 25 and the findings table is
 * bounded by `max_comments`, but this one iterated everything.
 *
 * Since 18eeb90 routes EVERY verifier rejection here instead of deleting it,
 * and each model call can return 25 findings across several passes, 100-200
 * candidates is reachable. At ~560 chars/row that breaches GitHub's 65536-char
 * review-body limit, `createReview` 422s, and the resilient fallback re-posts
 * the SAME oversized body — so it throws again and the ENTIRE review is lost,
 * including every confirmed P1 inline comment. Truncating a diagnostic table is
 * always better than losing the review that carries it.
 */
const MAX_MANUAL_ROWS = 25;

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
  nitpicks: ReviewFinding[] = [],
): string {
  const shortSha = meta.headSha.slice(0, 7);
  const lines: string[] = [
    '## Orvex Review',
    '',
    meta.isDeep
      ? `Deep-reviewed \`${meta.owner}/${meta.repo}#${meta.pr}\` @ \`${shortSha}\` — extra passes take longer than a standard review.`
      : `Reviewed \`${meta.owner}/${meta.repo}#${meta.pr}\` @ \`${shortSha}\`.`,
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

  // Partial-coverage banner — Orvex must be HONEST that part of the PR never
  // reached the model, so "no issues" below can't be read as full assurance.
  if (meta.coverage) {
    const { reviewed, candidates, skippedByCap, truncatedFiles, omittedPatch } = meta.coverage;
    const bits: string[] = [];
    if (skippedByCap > 0) bits.push(`${skippedByCap} file${skippedByCap === 1 ? '' : 's'} not reviewed (over the ${candidates}-file limit)`);
    if (truncatedFiles > 0) bits.push(`${truncatedFiles} large file${truncatedFiles === 1 ? '' : 's'} only partially reviewed`);
    if (omittedPatch) bits.push(`${omittedPatch} file${omittedPatch === 1 ? '' : 's'} not reviewed (diff too large for GitHub to return)`);
    lines.push(
      '',
      `> ⚠️ **Partial review — ${reviewed}/${candidates} changed files fully reviewed.** ${bits.join('; ')}. Findings below cover only the reviewed portion; this is NOT a full-PR sign-off. Split the PR or raise the limit to review the rest.`,
    );
  }

  // Pass-level partial coverage: same honesty rule as the file-level banner above.
  if (meta.skippedLenses && meta.skippedLenses.length > 0) {
    const n = meta.skippedLenses.length;
    lines.push(
      '',
      `> ⚠️ **${n} review pass${n === 1 ? '' : 'es'} did not complete** (${meta.skippedLenses.join(', ')}). ` +
        `The findings below come from the passes that finished; this is NOT a full sign-off for the missing ` +
        `lens${n === 1 ? '' : 'es'}. Re-run \`${meta.trigger ?? '@orvex'} review\` to retry.`,
    );
  }

  if (meta.verificationIncomplete) {
    lines.push(
      '',
      `> ⚠️ **Verification incomplete** — ${meta.verificationIncomplete} ` +
        `Findings below were NOT precision-gated; this is NOT a fully verified sign-off. ` +
        `Re-run \`${meta.trigger ?? '@orvex'} review\` to retry verification.`,
    );
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
  const hasStillOpen = (meta.stillOpen?.length ?? 0) > 0;
  const manualReview = meta.reviewOnly ?? [];
  if (tableFindings.length === 0 && nitpicks.length === 0 && !hasStillOpen && manualReview.length === 0) {
    lines.push(
      '',
      meta.coverage
        ? '✅ **No issues found in the reviewed files.** Note the partial-coverage warning above — the un-reviewed files were NOT checked, so this is not a full sign-off.'
        : meta.skippedLenses && meta.skippedLenses.length > 0
          ? // A pass that never ran cannot vouch for what it would have found, so
            // this must NOT read as a clean bill of health. Previously the banner
            // above was immediately contradicted by "it looks good to merge".
            '✅ **No issues found by the passes that completed.** One or more review passes did not finish (see the warning above), so this is NOT a full sign-off — re-run to cover the missing lens.'
          : meta.verificationIncomplete
            ? '✅ **No issues found by the discovery passes.** Precision verification did not complete (see the warning above), so this is NOT a fully verified sign-off.'
          : '✅ **No issues found.** Nothing in this change looked unsafe or incorrect on this pass — it looks good to merge.',
    );
  } else if (tableFindings.length === 0 && nitpicks.length > 0 && !hasStillOpen && manualReview.length === 0) {
    lines.push('', `✅ **No blocking issues.** Just ${nitpicks.length} low-severity ${nitpicks.length === 1 ? 'note' : 'notes'}, folded below.`);
  } else if (tableFindings.length === 0 && !hasStillOpen && manualReview.length > 0) {
    lines.push('', `🔎 **No confirmed issues to post inline.** ${manualReview.length} candidate${manualReview.length === 1 ? '' : 's'} needs manual review below.`);
  } else if (tableFindings.length === 0) {
    lines.push('', '**No new issues on this pass** — the previously reported findings below are still open.');
  } else {
    lines.push('', '| Severity | File | Message |', '| --- | --- | --- |');
    for (const f of tableFindings) {
      const file = f.line ? `\`${sanitizeFileCell(f.file)}:${f.line}\`` : `\`${sanitizeFileCell(f.file)}\``;
      const msg = sanitizeFindingText(f.message).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${f.severity} | ${file} | ${msg} |`);
    }

    const withSuggestions = tableFindings.filter((f) => f.suggestion);
    if (withSuggestions.length > 0) {
      lines.push('', '<details><summary>Suggestions</summary>', '');
      for (const f of withSuggestions) {
        // Sanitize BOTH fields — this block previously rendered them raw, the one
        // path that skipped sanitizeFindingText, allowing an apply-marker/checkbox
        // injected via a finding message to hijack a fix (planted marker becomes
        // the first in the comment → ticking a box applies a different fix).
        lines.push(`**\`${sanitizeFileCell(f.file)}\`** — ${sanitizeFindingText(f.message)}`, '', sanitizeFindingText(f.suggestion), '');
      }
      lines.push('</details>');
    }

    // One-click "fix everything" box — the discoverable equivalent of ticking
    // every inline apply-box by hand. Orvex re-verifies each finding before it
    // writes anything, so a false positive never turns into a bad commit.
    if (meta.canAutofix && meta.trigger) {
      const t = meta.trigger;
      lines.push(
        '',
        '<details><summary>🛠️ <b>Fix all of these with Orvex</b> — one command</summary>',
        '',
        `Comment **\`${t} fix all\`** on this PR and Orvex will apply every ready fix and AI-generate the rest, committing to this branch. Each finding is **re-verified before it's fixed**, so confirmed false positives are skipped rather than "fixed".`,
        '',
        `| Command | What it does |`,
        `| --- | --- |`,
        `| \`${t} fix\` | Apply only the fixes Orvex already has ready |`,
        `| \`${t} fix all\` | Apply ready fixes **and** AI-generate fixes for the rest |`,
        '',
        `<sub>Prefer to pick and choose? Tick the **Apply this fix** box on any inline comment, or copy that comment's *🤖 Prompt for AI agents* into Cursor / Claude / Codex.</sub>`,
        '</details>',
      );
    }
  }

  // Folded low-severity notes (info/Low, plus P3/Medium only if a repo opted into
  // fold_medium) — collapsed so they never clutter the actionable findings.
  if (nitpicks.length > 0) {
    lines.push(
      '',
      `<details><summary>🔍 ${nitpicks.length} low-severity ${nitpicks.length === 1 ? 'note' : 'notes'} (optional)</summary>`,
      '',
      '| Severity | File | Message |',
      '| --- | --- | --- |',
    );
    for (const f of nitpicks) {
      const file = f.line ? `\`${sanitizeFileCell(f.file)}:${f.line}\`` : `\`${sanitizeFileCell(f.file)}\``;
      const msg = sanitizeFindingText(f.message).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
      lines.push(`| ${f.severity} | ${file} | ${msg} |`);
    }
    lines.push('', '</details>');
  }

  if (manualReview.length > 0) {
    const SEV_ORDER: Record<string, number> = { P1: 0, P2: 1, P3: 2, info: 3 };
    const sortedManual = [...manualReview].sort(
      (a, b) =>
        (SEV_ORDER[a.finding.severity] ?? 9) - (SEV_ORDER[b.finding.severity] ?? 9),
    );
    // Always show every P1/P2 even if that exceeds MAX_MANUAL_ROWS — hiding a
    // high-severity candidate behind "N more" is worse than a longer table.
    const high = sortedManual.filter((m) => m.finding.severity === 'P1' || m.finding.severity === 'P2');
    const rest = sortedManual.filter((m) => m.finding.severity !== 'P1' && m.finding.severity !== 'P2');
    const restBudget = Math.max(0, MAX_MANUAL_ROWS - high.length);
    const shown = [...high, ...rest.slice(0, restBudget)];
    const hidden = sortedManual.length - shown.length;
    lines.push(
      '',
      `<details><summary>🔎 ${manualReview.length} finding${manualReview.length === 1 ? '' : 's'} for manual review</summary>`,
      '',
      'These candidates were not confirmed strongly enough for an inline comment or auto-fix. They are included so the evidence remains visible.',
      '',
      '| Severity | File | Candidate | Why manual review |',
      '| --- | --- | --- | --- |',
    );
    for (const { finding, reason } of shown) {
      const file = finding.line ? `\`${sanitizeFileCell(finding.file)}:${finding.line}\`` : `\`${sanitizeFileCell(finding.file)}\``;
      const message = sanitizeFindingText(finding.message).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
      const why = sanitizeFindingText(reason).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);
      lines.push(`| ${finding.severity} | ${file} | ${message} | ${why} |`);
    }
    if (hidden > 0) {
      lines.push(`| … | | **${hidden} more candidate(s) not shown** | body size limit |`);
    }
    lines.push('', '</details>');
  }

  // Full result set on re-runs: findings from earlier reviews still open on
  // this commit, so a same-commit re-review lists everything, not just "0 new".
  if (meta.stillOpen && meta.stillOpen.length > 0) {
    lines.push(
      '',
      `**Previously reported, still open (${meta.stillOpen.length})**`,
      '',
      '| Severity | File | Message |',
      '| --- | --- | --- |',
    );
    for (const f of meta.stillOpen) {
      const file = f.line ? `\`${sanitizeFileCell(f.file)}:${f.line}\`` : `\`${sanitizeFileCell(f.file)}\``;
      const msg = sanitizeFindingText(f.message).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
      lines.push(`| ${f.severity} | ${file} | ${msg} |`);
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

  const trigger = meta.trigger ?? '@orvex';
  lines.push('', formatReviewCommandsFooter(trigger));

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
    /** file/line — populated so the copy-paste AI-agent prompt can name the location */
    file?: string;
    line?: number;
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
  /**
   * The full content of the anchored line at HEAD. When supplied, a native
   * ```suggestion can be rendered only if the originalCode/fixedCode can be
   * expanded into a complete line replacement. Without this, the safe path is
   * the Orvex apply-checkbox.
   */
  anchoredLine?: string;
  /** true if the anchor was snapped to the nearest changed line (not exact). */
  lineRelocated?: boolean;
  /** true if the anchor is a context line in a deletion-only hunk. */
  anchorContext?: boolean;
}

/**
 * Body for one inline finding comment:
 * - a native ```suggestion block (GitHub renders the diff preview and its own
 *   per-comment "Commit suggestion" button) ONLY when the fix can be expanded
 *   into the full replacement for the anchored line and the anchor is exact
 * - an Orvex apply-checkbox as the bot-side fix button otherwise
 * - footer with thread commands
 */
/**
 * Neutralize an apply-marker or task-list checkbox planted in attacker-controlled
 * text (a finding message quotes the PR's own code/comments). Without this, a PR
 * author can embed `<!--orvex:apply:<other-fp>-->` or a fake `- [ ] Apply this
 * fix` line; because it renders ABOVE the real checkbox and the apply parser
 * takes the FIRST marker in the comment, ticking the real box would apply a
 * different finding's fix (or a fake button appears). Defang both sequences.
 */
/** Strip `|` and backticks from a file path before it's placed in a markdown
 *  table cell or code-span (git permits both in paths; unescaped they break the
 *  table row / span). */
export function sanitizeFileCell(file: string): string {
  return file.replace(/[|`]/g, '');
}

export function sanitizeFindingText(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/<!--\s*orvex:apply:/gi, '<!-- orvex-apply-blocked:')
    // Defang EVERY GFM task-list marker variant GitHub renders as a checkbox —
    // `- [ ]`, `* [ ]`, `+ [ ]`, `1. [ ]`, and blockquoted `> - [ ]` — not just
    // the dash form, so a planted checkbox can never surface in the comment.
    .replace(/^(\s*>?\s*)(?:[-*+]|\d+\.)\s*\[( |x|X)\]/gm, '$1• [$2]')
    // Neutralize the HTML that actually causes harm here, WITHOUT blanket-
    // escaping every angle bracket — findings legitimately contain `Array<string>`
    // and `if (a < b)`, and escaping those would render as literal `&lt;` inside
    // code spans.
    //
    // This text is model output produced immediately after reading an
    // attacker-controlled PR, and 18eeb90 newly embeds it inside the
    // manual-review `<details>` block. A planted `</details>` or `</summary>`
    // BREAKS OUT of the collapsed section and renders at the top level of the
    // review comment; `<img>`/`<script>`/`<iframe>` render outright.
    .replace(/<\s*\/\s*(details|summary)\s*>/gi, '&lt;/$1&gt;')
    .replace(/<\s*(script|iframe|img|a|style|form|object|embed)\b/gi, '&lt;$1');
}

export function formatInlineFinding(r: InlineFindingRender): string {
  const f = { ...r.finding, message: sanitizeFindingText(r.finding.message), suggestion: sanitizeFindingText(r.finding.suggestion) };
  const parts = [`**${f.severity}** · \`${f.ruleId}\``, '', f.message];

  const fixedCode = f.fixedCode;
  const originalCode = f.originalCode;
  const canExpandNative =
    fixedCode !== undefined &&
    originalCode !== undefined &&
    !originalCode.includes('\n') &&
    !fixedCode.includes('\n') &&
    !fixedCode.includes('```') &&
    !r.lineRelocated &&
    !r.anchorContext &&
    r.anchoredLine !== undefined &&
    r.anchoredLine.includes(originalCode);

  let suggestedLine: string | undefined;
  if (canExpandNative) {
    const line = r.anchoredLine!.replace(originalCode, fixedCode);
    if (!line.includes('\n')) suggestedLine = line;
  }

  if (suggestedLine !== undefined) {
    // P3-5: an odd number of triple-backtick fences in the message would swallow
    // the suggestion opener. Close any open fence before emitting the suggestion.
    const openFences = (parts.join('\n').match(/```/g) ?? []).length;
    if (openFences % 2 === 1) parts.push('```');

    // NATIVE GitHub suggestion → an INSTANT "Commit suggestion" button (GitHub
    // applies it itself, no webhook, no page refresh). Only used when the block
    // contains the COMPLETE replacement for the anchored line, so clicking
    // "Commit suggestion" never replaces the line with a minimal substring.
    parts.push('', '```suggestion', suggestedLine, '```');
    parts.push(
      '',
      r.canAutofix !== false
        ? `⚡ **Apply instantly** with GitHub's **Commit suggestion** button above · <sub>or \`${r.trigger} fix this\` for an Orvex-verified commit · \`${r.trigger} explain\` · \`${r.trigger} ignore\`</sub>`
        : `⚡ **Apply instantly** with GitHub's **Commit suggestion** button above · <sub>\`${r.trigger} ignore\` to dismiss</sub>`,
    );
  } else if (r.canAutofix !== false) {
    // No safe native-suggestion possible (multi-line / cross-file / relocated /
    // no anchored line) → the Orvex apply-checkbox.
    if (f.suggestion) parts.push('', f.suggestion);
    parts.push('', applyCheckboxLine(f.fingerprint, fixedCode !== undefined));
    parts.push(
      '',
      `<sub>Tick the box to let Orvex commit this fix — the ⏳ status updates in a moment (GitHub doesn't live-refresh bot edits, so give it a few seconds). Or \`${r.trigger} fix this\` · \`${r.trigger} <instructions>\` · \`${r.trigger} explain\` · \`${r.trigger} ignore\`</sub>`,
    );
  } else {
    // Free trial: no commit-a-fix checkbox (that's paid) — any suggestion above
    // is applied by hand. Don't render a button that can only be rejected.
    if (f.suggestion) parts.push('', f.suggestion);
    parts.push(
      '',
      `<sub>Apply the suggested change above by hand, or [upgrade](https://useorvex.com/#pricing) to let Orvex commit fixes · \`${r.trigger} ignore\` to dismiss.</sub>`,
    );
  }

  // Ready-to-paste prompt for an external AI agent (Cursor / Claude / Codex).
  // Collapsed so it never clutters the comment; the quad-backtick fence lets the
  // prompt safely contain its own ``` blocks.
  parts.push(
    '',
    '<details><summary>🤖 Prompt for AI agents</summary>',
    '',
    '````',
    buildAgentPrompt(f),
    '````',
    '</details>',
  );

  return parts.join('\n');
}

/** A copy-pasteable instruction for Cursor/Claude/Codex to fix ONE finding. */
function buildAgentPrompt(f: InlineFindingRender['finding']): string {
  const loc = f.file
    ? f.line
      ? `\`${f.file}\` around line ${f.line}`
      : `\`${f.file}\``
    : 'the code at the line this comment is on';
  // Neutralize both an injected apply-marker/checkbox AND any 4+-backtick run that
  // would close the outer quad-backtick fence early and surface content outside it.
  const safeCode = (c: string) => sanitizeFindingText(c).replace(/`{4,}/g, '```');
  const out: string[] = [`Fix this issue in ${loc}:`, '', f.message.trim()];
  if (f.originalCode && f.fixedCode) {
    out.push('', 'Suggested change:', '```', `- ${safeCode(f.originalCode)}`, `+ ${safeCode(f.fixedCode)}`, '```');
  } else if (f.suggestion) {
    out.push('', `Suggested approach: ${f.suggestion.trim()}`);
  }
  out.push(
    '',
    'Make only this change and keep the surrounding code, style, and behaviour intact. ' +
      'Do not touch unrelated code. If a test covers this path, update or add one.',
  );
  return out.join('\n');
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

// Help / command catalog lives in commands-catalog.ts (single source of truth).
export {
  formatHelpComment,
  formatReviewCommandsFooter,
  formatCommandsMarkdownTable,
  formatUsageNotesMarkdown,
  formatCommandsHtmlRows,
  orvexCommandCatalog,
  whereLabel,
  type OrvexCommandDoc,
  type CommandWhere,
} from './commands-catalog.js';
