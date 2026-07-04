export type OrvexCommand =
  | { kind: 'review' }
  | { kind: 'fix' } // apply Orvex's ready suggestions
  | { kind: 'fix_all' } // also generate fixes for findings without one
  | { kind: 'fix_this' } // thread reply on one finding
  | { kind: 'ignore' } // thread reply: suppress this finding permanently
  | { kind: 'explain' } // thread reply: deep-dive explanation of the finding
  | { kind: 'auto_apply'; enabled: boolean }
  | { kind: 'help' }
  | { kind: 'prompt'; instruction: string }; // free-form AI fix instruction

export function commandTrigger(): string {
  return process.env.ORVEX_TRIGGER ?? '@orvex';
}

/**
 * Parse an `@orvex …` command out of a PR / review comment body.
 * Returns null when the comment doesn't address the bot.
 */
export function parseOrvexCommand(body: string, trigger = commandTrigger()): OrvexCommand | null {
  const lower = body.toLowerCase();
  const idx = lower.indexOf(trigger.toLowerCase());
  if (idx === -1) return null;
  // must be at start of the body or preceded by whitespace (not e.g. an email)
  if (idx > 0 && !/\s/.test(body[idx - 1])) return null;

  const rest = body
    .slice(idx + trigger.length)
    .split('\n')[0]
    .trim();
  const normalized = rest
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/ (please|pls|thanks|thank you)$/, '')
    .trim();

  if (normalized === '' || normalized === 'help') return { kind: 'help' };
  if (normalized === 'review' || normalized === 're-review' || normalized === 'rereview') {
    return { kind: 'review' };
  }
  if (normalized === 'fix all' || normalized === 'fix-all' || normalized === 'fixall') {
    return { kind: 'fix_all' };
  }
  if (normalized === 'fix this' || normalized === 'fix it') return { kind: 'fix_this' };
  if (normalized === 'fix') return { kind: 'fix' };
  if (normalized === 'ignore' || normalized === 'ignore this' || normalized === 'dismiss') {
    return { kind: 'ignore' };
  }
  if (normalized === 'explain' || normalized === 'explain this' || normalized === 'why') {
    return { kind: 'explain' };
  }
  if (/^auto[- ]?apply (on|enable|enabled)$/.test(normalized)) {
    return { kind: 'auto_apply', enabled: true };
  }
  if (/^auto[- ]?apply (off|disable|disabled)$/.test(normalized)) {
    return { kind: 'auto_apply', enabled: false };
  }

  return { kind: 'prompt', instruction: rest };
}
