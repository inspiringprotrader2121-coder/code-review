import type { ReviewFinding } from './finding.js';

export interface ReviewCommentMeta {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  stats?: { newCount: number; fixedCount: number; openCount: number };
  summary?: string;
}

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

  const tableFindings = [...inline, ...summaryOnly];
  if (tableFindings.length === 0) {
    lines.push('', 'No new issues in the reviewed hunks.');
    return lines.join('\n');
  }

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

/** Extract the finding fingerprint from a comment carrying an apply checkbox. */
export function parseApplyMarker(body: string): string | null {
  const m = body.match(/<!--orvex:apply:([a-f0-9]{16})-->/);
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

  // Always offer the fix checkbox. If no fix was pre-generated, Orvex generates
  // one on demand when the box is ticked (or `@orvex fix this` is replied).
  const label = fixedCode !== undefined ? 'Apply this fix' : 'Fix this with Orvex';
  parts.push('', `- [ ] ${applyMarker(f.fingerprint)} **${label}** — Orvex commits to this PR branch`);

  parts.push(
    '',
    `<sub>Tick the box above, or reply \`${r.trigger} fix this\` · \`${r.trigger} <instructions>\` for a custom fix · \`${r.trigger} explain\` · \`${r.trigger} ignore\`</sub>`,
  );

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
      '> ⚠️ The branch received new commits while fixes were being applied — remaining fixes were aborted to avoid overwriting concurrent edits. Re-run when the branch is quiet.',
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
    `| \`${trigger} auto-apply on/off\` | Auto-commit Orvex's ready fixes after each future review of this PR |`,
    '',
    '<sub>Fixes are committed to the PR branch. Before committing, Orvex verifies the branch head has not moved and the target code is unchanged; if someone is editing concurrently, the fix is aborted rather than applied blindly.</sub>',
  ].join('\n');
}
