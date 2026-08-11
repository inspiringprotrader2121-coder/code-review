import type { ReviewFinding } from '../finding.js';
import { formatReviewCommandsFooter } from '../commands-catalog.js';
import { displaySeverity } from '../severity.js';
import type { ReviewCommentMeta } from './contracts.js';
import { sanitizeFileCell, sanitizeFindingText } from './sanitize.js';

const MAX_FILES_LISTED = 25;
const MAX_MANUAL_ROWS = 25;
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
  if (meta.summary) lines.push('', sanitizeFindingText(meta.summary));

  if (meta.coverage) {
    const { reviewed, candidates, skippedByCap, truncatedFiles, omittedPatch, githubCapHit } =
      meta.coverage;
    const bits: string[] = [];
    if (skippedByCap > 0)
      bits.push(
        `${skippedByCap} file${skippedByCap === 1 ? '' : 's'} not reviewed (over the ${candidates}-file limit)`,
      );
    if (githubCapHit)
      bits.push("GitHub's hard 3,000-file diff cap was reached; the exact remainder is unknown");
    if (truncatedFiles > 0)
      bits.push(
        `${truncatedFiles} large file${truncatedFiles === 1 ? '' : 's'} only partially reviewed`,
      );
    if (omittedPatch)
      bits.push(
        `${omittedPatch} file${omittedPatch === 1 ? '' : 's'} not reviewed (diff too large for GitHub to return)`,
      );
    lines.push(
      '',
      `> ⚠️ **Partial review — ${reviewed}/${candidates} changed files fully reviewed.** ${bits.join('; ')}. Findings below cover only the reviewed portion; this is NOT a full-PR sign-off. Split the PR or raise the limit to review the rest.`,
    );
  }
  if (meta.skippedLenses && meta.skippedLenses.length > 0) {
    const count = meta.skippedLenses.length;
    lines.push(
      '',
      `> ⚠️ **${count} review pass${count === 1 ? '' : 'es'} did not complete** (${meta.skippedLenses.join(', ')}). ` +
        `The findings below come from the passes that finished; this is NOT a full sign-off for the missing ` +
        `lens${count === 1 ? '' : 'es'}. Re-run \`${meta.trigger ?? '@orvex'} review\` to retry.`,
    );
  }
  if ((meta.verificationInconclusiveCount ?? 0) > 0) {
    const count = meta.verificationInconclusiveCount!;
    const subject = `${count} Critical/High finding${count === 1 ? '' : 's'}`;
    lines.push(
      '',
      `> ⚠️ **Verification completed, but ${subject} ${count === 1 ? 'is' : 'are'} inconclusive.** ${
        count === 1 ? 'It remains' : 'They remain'
      } visible for manual review; the remaining posted findings were precision-gated.`,
    );
  } else if (meta.verificationIncomplete) {
    lines.push(
      '',
      `> ⚠️ **Verification incomplete** — ${meta.verificationIncomplete} ` +
        `Findings below were NOT precision-gated; this is NOT a fully verified sign-off. ` +
        `Re-run \`${meta.trigger ?? '@orvex'} review\` to retry verification.`,
    );
  }
  if (meta.filesReviewed && meta.filesReviewed.length > 0) {
    const shown = meta.filesReviewed.slice(0, MAX_FILES_LISTED);
    const extra = meta.filesReviewed.length - shown.length;
    lines.push(
      '',
      `**Files reviewed (${meta.filesReviewed.length})**`,
      ...shown.map((file) => `- \`${file}\``),
      ...(extra > 0 ? [`- …and ${extra} more`] : []),
    );
  }

  const tableFindings = [...inline, ...summaryOnly];
  const hasStillOpen = (meta.stillOpen?.length ?? 0) > 0;
  const manualReview = meta.reviewOnly ?? [];
  if (
    tableFindings.length === 0 &&
    nitpicks.length === 0 &&
    !hasStillOpen &&
    manualReview.length === 0
  ) {
    lines.push(
      '',
      meta.coverage
        ? '✅ **No issues found in the reviewed files.** Note the partial-coverage warning above — the un-reviewed files were NOT checked, so this is not a full sign-off.'
        : meta.skippedLenses && meta.skippedLenses.length > 0
          ? '✅ **No issues found by the passes that completed.** One or more review passes did not finish (see the warning above), so this is NOT a full sign-off — re-run to cover the missing lens.'
          : meta.verificationIncomplete
            ? '✅ **No issues found by the discovery passes.** Precision verification did not complete (see the warning above), so this is NOT a fully verified sign-off.'
            : '✅ **No issues found.** Nothing in this change looked unsafe or incorrect on this pass — it looks good to merge.',
    );
  } else if (
    tableFindings.length === 0 &&
    nitpicks.length > 0 &&
    !hasStillOpen &&
    manualReview.length === 0
  ) {
    lines.push(
      '',
      `✅ **No blocking issues.** Just ${nitpicks.length} low-severity ${nitpicks.length === 1 ? 'note' : 'notes'}, folded below.`,
    );
  } else if (tableFindings.length === 0 && !hasStillOpen && manualReview.length > 0) {
    lines.push(
      '',
      `🔎 **No confirmed issues to post inline.** ${manualReview.length} candidate${manualReview.length === 1 ? '' : 's'} needs manual review below.`,
    );
  } else if (tableFindings.length === 0) {
    lines.push(
      '',
      '**No new issues on this pass** — the previously reported findings below are still open.',
    );
  } else {
    lines.push('', '| Severity | File | Message |', '| --- | --- | --- |');
    for (const finding of tableFindings) {
      const file = finding.line
        ? `\`${sanitizeFileCell(finding.file)}:${finding.line}\``
        : `\`${sanitizeFileCell(finding.file)}\``;
      const message = sanitizeFindingText(finding.message)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      lines.push(`| ${displaySeverity(finding.severity)} | ${file} | ${message} |`);
    }
    const withSuggestions = tableFindings.filter((finding) => finding.suggestion);
    if (withSuggestions.length > 0) {
      lines.push('', '<details><summary>Suggestions</summary>', '');
      for (const finding of withSuggestions) {
        lines.push(
          `**\`${sanitizeFileCell(finding.file)}\`** — ${sanitizeFindingText(finding.message)}`,
          '',
          sanitizeFindingText(finding.suggestion),
          '',
        );
      }
      lines.push('</details>');
    }
    if (meta.canAutofix && meta.trigger) {
      const trigger = meta.trigger;
      lines.push(
        '',
        '<details><summary>🛠️ <b>Fix all of these with Orvex</b> — one command</summary>',
        '',
        `Comment **\`${trigger} fix all\`** on this PR and Orvex will apply every ready fix and AI-generate the rest, committing to this branch. Each finding is **re-verified before it's fixed**, so confirmed false positives are skipped rather than "fixed".`,
        '',
        '| Command | What it does |',
        '| --- | --- |',
        `| \`${trigger} fix\` | Apply only the fixes Orvex already has ready |`,
        `| \`${trigger} fix all\` | Apply ready fixes **and** AI-generate fixes for the rest |`,
        '',
        `<sub>Prefer to pick and choose? Tick the **Apply this fix** box on any inline comment, or copy that comment's *🤖 Prompt for AI agents* into Cursor / Claude / Codex.</sub>`,
        '</details>',
      );
    }
  }

  if (nitpicks.length > 0) {
    lines.push(
      '',
      `<details><summary>🔍 ${nitpicks.length} low-severity ${nitpicks.length === 1 ? 'note' : 'notes'} (optional)</summary>`,
      '',
      '| Severity | File | Message |',
      '| --- | --- | --- |',
    );
    for (const finding of nitpicks) {
      const file = finding.line
        ? `\`${sanitizeFileCell(finding.file)}:${finding.line}\``
        : `\`${sanitizeFileCell(finding.file)}\``;
      const message = sanitizeFindingText(finding.message)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')
        .slice(0, 300);
      lines.push(`| ${displaySeverity(finding.severity)} | ${file} | ${message} |`);
    }
    lines.push('', '</details>');
  }

  if (manualReview.length > 0) {
    const severityOrder: Record<string, number> = { P1: 0, P2: 1, P3: 2, info: 3 };
    const sorted = [...manualReview].sort(
      (left, right) =>
        (severityOrder[left.finding.severity] ?? 9) - (severityOrder[right.finding.severity] ?? 9),
    );
    const high = sorted.filter(
      ({ finding }) => finding.severity === 'P1' || finding.severity === 'P2',
    );
    const rest = sorted.filter(
      ({ finding }) => finding.severity !== 'P1' && finding.severity !== 'P2',
    );
    const shown = [...high, ...rest.slice(0, Math.max(0, MAX_MANUAL_ROWS - high.length))];
    const hidden = sorted.length - shown.length;
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
      const file = finding.line
        ? `\`${sanitizeFileCell(finding.file)}:${finding.line}\``
        : `\`${sanitizeFileCell(finding.file)}\``;
      const message = sanitizeFindingText(finding.message)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')
        .slice(0, 300);
      const why = sanitizeFindingText(reason)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')
        .slice(0, 220);
      lines.push(`| ${displaySeverity(finding.severity)} | ${file} | ${message} | ${why} |`);
    }
    if (hidden > 0)
      lines.push(`| … | | **${hidden} more candidate(s) not shown** | body size limit |`);
    lines.push('', '</details>');
  }

  if (meta.stillOpen && meta.stillOpen.length > 0) {
    lines.push(
      '',
      `**Previously reported, still open (${meta.stillOpen.length})**`,
      '',
      '| Severity | File | Message |',
      '| --- | --- | --- |',
    );
    for (const finding of meta.stillOpen) {
      const file = finding.line
        ? `\`${sanitizeFileCell(finding.file)}:${finding.line}\``
        : `\`${sanitizeFileCell(finding.file)}\``;
      const message = sanitizeFindingText(finding.message)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')
        .slice(0, 200);
      lines.push(`| ${displaySeverity(finding.severity)} | ${file} | ${message} |`);
    }
  }

  lines.push(
    '',
    '<details><summary>What Orvex checked for</summary>',
    '',
    ...CHECKLIST.map((item) => `- ${item}`),
    '</details>',
    '',
    formatReviewCommandsFooter(meta.trigger ?? '@orvex'),
  );
  return lines.join('\n');
}
