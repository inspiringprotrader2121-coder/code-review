import type { FixSummaryInput } from './contracts.js';
import { sanitizeFileCell, sanitizeFindingText } from './sanitize.js';

export function formatFixedReply(shortSha: string): string {
  return `✅ Fixed on \`${shortSha}\` (verified on HEAD).`;
}

export function formatFixAppliedReply(shortSha: string, requestedBy?: string): string {
  const by = requestedBy ? ` (requested by @${requestedBy})` : '';
  return `✅ **Fix applied** in \`${shortSha}\`${by}.`;
}

export function formatFixSkippedReply(reason: string): string {
  return `⚠️ **Fix not applied** — ${reason}`;
}

export function formatFixSummaryComment(input: FixSummaryInput): string {
  const lines: string[] = ['## Orvex Fix'];
  if (input.applied.length > 0) {
    lines.push(
      '',
      `Applied **${input.applied.length}** fix${input.applied.length === 1 ? '' : 'es'}:`,
    );
    for (const applied of input.applied) {
      lines.push(
        `- \`${sanitizeFileCell(applied.file)}\` — ${sanitizeFindingText(applied.message)} → \`${applied.sha.slice(0, 7)}\``,
      );
    }
  } else {
    lines.push('', 'No fixes were applied.');
  }
  if (input.skipped.length > 0) {
    lines.push('', `Skipped **${input.skipped.length}**:`);
    for (const skipped of input.skipped) {
      lines.push(
        `- \`${sanitizeFileCell(skipped.file)}\` — ${sanitizeFindingText(skipped.message)}: ${sanitizeFindingText(skipped.reason)}`,
      );
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
    : '⏹ **Auto-apply is OFF** for this PR.';
}
