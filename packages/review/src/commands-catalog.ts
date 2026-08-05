/**
 * Single source of truth for every user-facing `@orvex` command.
 * Parsed kinds live in `commands.ts`; this catalog drives help text,
 * dashboard/marketing copy, and review-comment footers.
 */

export type CommandWhere = 'pr' | 'thread' | 'either';

export type OrvexCommandDoc = {
  /** Canonical usage after the trigger, e.g. `review` or `ignore <file>:<line>` */
  usage: string;
  /** Short effect shown in tables */
  effect: string;
  where: CommandWhere;
  /** Alternate phrasings the parser accepts */
  aliases?: string[];
};

/** Full catalog — keep in sync with `parseOrvexCommand`. */
export function orvexCommandCatalog(): OrvexCommandDoc[] {
  return [
    {
      usage: 'review',
      effect: 'Re-run the review on the current PR head',
      where: 'either',
      aliases: ['re-review', 'rereview'],
    },
    {
      usage: 'deep',
      effect: 'Extra analysis passes unioned into this PR (paid plans; counts as 2 review units)',
      where: 'either',
      aliases: ['deep review', 'review deep'],
    },
    {
      usage: 'fix',
      effect:
        "On a PR: apply all ready fixes. On a finding thread: same as `fix this` (that finding only)",
      where: 'either',
    },
    {
      usage: 'fix all',
      effect: 'Apply ready fixes and AI-generate fixes for remaining findings',
      where: 'either',
      aliases: ['fix-all', 'fixall'],
    },
    {
      usage: 'fix this',
      effect: "Apply just that finding's fix",
      where: 'thread',
      aliases: ['fix it'],
    },
    {
      usage: '<instructions>',
      effect: 'AI fix following your instructions (reply on a finding), or ask/change on the PR',
      where: 'either',
    },
    {
      usage: 'explain',
      effect: 'Deep-dive explanation of the finding',
      where: 'thread',
      aliases: ['explain this', 'why'],
    },
    {
      usage: 'ignore',
      effect: 'Never report this finding again on the repo',
      where: 'thread',
      aliases: ['ignore this', 'dismiss'],
    },
    {
      usage: 'ignore <file>:<line>',
      effect: 'Silence a manual-review candidate by file (and optional line) from a PR comment',
      where: 'pr',
      aliases: ['dismiss <file>:<line>', 'ignore <file>'],
    },
    {
      usage: 'resolve conflicts',
      effect: 'Merge the base branch in to clear conflicts git can auto-resolve',
      where: 'either',
      aliases: [
        'resolve conflict',
        'fix conflicts',
        'fix merge conflicts',
        'resolve merge conflicts',
      ],
    },
    {
      usage: 'auto-apply on/off',
      effect: "Auto-commit Orvex's ready fixes after each future review of this PR",
      where: 'either',
      aliases: ['auto apply on/off', 'autoapply on/off', 'auto-apply enable/disable'],
    },
    {
      usage: 'rate limit',
      effect: 'Show remaining hourly / monthly review quota (does not start a review)',
      where: 'either',
      aliases: ['rate-limit', 'ratelimit', 'quota', 'usage', 'reviews remaining', 'remaining'],
    },
    {
      usage: 'help',
      effect: 'Show this command list',
      where: 'either',
    },
  ];
}

export function whereLabel(where: CommandWhere): string {
  if (where === 'pr') return 'PR comment';
  if (where === 'thread') return 'Reply on a finding';
  return 'PR or finding thread';
}

/** Markdown table used by `@orvex help` and docs. */
export function formatCommandsMarkdownTable(trigger: string): string {
  const rows = orvexCommandCatalog().map((c) => {
    const where =
      c.where === 'thread'
        ? ' (reply on a finding)'
        : c.where === 'pr'
          ? ' (PR comment)'
          : '';
    return `| \`${trigger} ${c.usage}\`${where} | ${c.effect} |`;
  });
  return ['| Command | Effect |', '| --- | --- |', ...rows].join('\n');
}

/** Extra usage notes shared across help surfaces. */
export function formatUsageNotesMarkdown(trigger: string): string {
  return [
    '### How reviews are triggered',
    '',
    `- **Automatic:** Orvex reviews when a PR opens and (if enabled) on each new push. Control this per repo in the dashboard under **Automatic review triggers** → **Run on each commit**.`,
    `- **Manual:** \`${trigger} review\` always works, even when automatic push reviews are off.`,
    `- **Apply checkbox:** Tick **Apply this fix** on an Orvex finding comment to commit that one fix.`,
    '',
    '### What counts toward quota',
    '',
    `- A completed standard review uses **1** unit. \`${trigger} deep\` uses **2**.`,
    '- Skipped reviews (blocked before work), fix commands, and explain/ask commands do **not** consume review units. Failed reviews still count toward free-trial and hourly caps.',
    `- Check remaining capacity anytime with \`${trigger} rate limit\` (does not start a review).`,
    '',
    `<sub>Fixes are committed to the PR branch. Before committing, Orvex verifies the branch head has not moved and the target code is unchanged; if someone is editing concurrently, the fix is aborted rather than applied blindly.</sub>`,
  ].join('\n');
}

export function formatHelpComment(trigger: string): string {
  return [
    '## Orvex commands',
    '',
    formatCommandsMarkdownTable(trigger),
    '',
    formatUsageNotesMarkdown(trigger),
  ].join('\n');
}

/** Compact footer for the main PR review summary comment. */
export function formatReviewCommandsFooter(trigger: string): string {
  return (
    `<sub>Commands: \`${trigger} help\` · quota: \`${trigger} rate limit\` · ` +
    `re-review: \`${trigger} review\` · fixes: \`${trigger} fix\` / \`${trigger} fix all\`</sub>`
  );
}

/** Escape for HTML attribute/text contexts when embedding command docs. */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** HTML table body rows for dashboard / marketing (caller wraps in <table>). */
export function formatCommandsHtmlRows(trigger: string): string {
  return orvexCommandCatalog()
    .map((c) => {
      const cmd = escapeHtmlText(`${trigger} ${c.usage}`);
      const effect = escapeHtmlText(c.effect);
      const where = escapeHtmlText(whereLabel(c.where));
      return `<tr><td><code>${cmd}</code></td><td>${where}</td><td>${effect}</td></tr>`;
    })
    .join('');
}
