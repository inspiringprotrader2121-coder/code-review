export type OrvexCommand =
  | { kind: 'review' }
  | { kind: 'deep' } // extra diverse passes unioned into the same review (paid plans)
  | { kind: 'fix' } // apply Orvex's ready suggestions
  | { kind: 'fix_all' } // also generate fixes for findings without one
  | { kind: 'fix_this' } // thread reply on one finding
  | { kind: 'ignore' } // thread reply: suppress this finding permanently
  | { kind: 'explain' } // thread reply: deep-dive explanation of the finding
  | { kind: 'resolve_conflicts' } // attempt to resolve merge conflicts
  | { kind: 'auto_apply'; enabled: boolean }
  | { kind: 'help' }
  | { kind: 'prompt'; instruction: string }; // free-form AI instruction (ask / change)

export function commandTrigger(): string {
  return process.env.ORVEX_TRIGGER ?? '@orvex';
}

/**
 * Parse an `@orvex …` command out of a PR / review comment body.
 * Returns null when the comment doesn't address the bot.
 */
export function parseOrvexCommand(body: string, trigger = commandTrigger()): OrvexCommand | null {
  // Strip fenced code blocks and markdown blockquote lines BEFORE searching — a
  // quoted prior comment (GitHub "Quote reply" produces `> @orvex fix all`) or a
  // fenced mention must NOT re-trigger a command (esp. destructive `fix all`).
  const scanBody = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ');
  const lower = scanBody.toLowerCase();
  const idx = lower.indexOf(trigger.toLowerCase());
  if (idx === -1) return null;
  // must be at start or preceded by whitespace (not e.g. an email), AND the char
  // AFTER the trigger must be a boundary — reject `@orvexander` (trigger as a
  // prefix of a longer handle) which otherwise fired with garbled instruction text.
  if (idx > 0 && !/\s/.test(scanBody[idx - 1])) return null;
  const after = scanBody[idx + trigger.length];
  if (after !== undefined && /\w/.test(after)) return null;

  const rest = scanBody
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
  if (normalized === 'deep' || normalized === 'deep review' || normalized === 'review deep') {
    return { kind: 'deep' };
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
  if (
    normalized === 'resolve conflicts' ||
    normalized === 'resolve conflict' ||
    normalized === 'fix conflicts' ||
    normalized === 'fix merge conflicts' ||
    normalized === 'resolve merge conflicts'
  ) {
    return { kind: 'resolve_conflicts' };
  }
  if (/^auto[- ]?apply (on|enable|enabled)$/.test(normalized)) {
    return { kind: 'auto_apply', enabled: true };
  }
  if (/^auto[- ]?apply (off|disable|disabled)$/.test(normalized)) {
    return { kind: 'auto_apply', enabled: false };
  }

  // Only dispatch a free-form agent (LLM cost + a commit surface) when the text
  // is a REAL instruction — it must contain a recognized imperative verb. A bare
  // question ("@orvex thoughts?") or casual chatter ("@orvex looks great here")
  // must NOT enqueue a paid job; the old ≥3-words / trailing-? heuristics let
  // exactly those through. A genuine "why/how/explain … ?" still qualifies via the
  // verb list.
  const looksActionable =
    /\b(fix|change|add|remove|rename|refactor|update|make|replace|move|delete|rewrite|implement|explain|why|how|convert|handle|validate|escape|sanitize|review|check|investigate|resolve|correct|improve|use|prefer|extract|wrap|inline|simplify|consolidate|split|merge|guard|ensure|avoid|switch)\b/i.test(
      rest,
    );
  if (!rest.trim() || !looksActionable) return { kind: 'help' };
  return { kind: 'prompt', instruction: rest };
}
