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
    '## Velatrix Review',
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
