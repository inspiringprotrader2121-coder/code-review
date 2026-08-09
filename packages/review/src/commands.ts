export type OrvexCommand =
  | { kind: 'review' }
  | { kind: 'deep' } // extra diverse passes unioned into the same review (paid plans)
  | { kind: 'fix' } // apply Orvex's ready suggestions
  | { kind: 'fix_all' } // also generate fixes for findings without one
  | { kind: 'fix_this' } // thread reply on one finding
  | { kind: 'ignore' } // thread reply: suppress this finding permanently
  /**
   * PR-level: suppress a specific candidate by location. Manual-review
   * candidates are rendered in a collapsed table with NO inline comment, so
   * the thread-reply form of `ignore` (which resolves via githubCommentId)
   * can never reach them — they repeated on every push with no way to silence
   * them. `@orvex ignore src/a.ts:42` gives them a handle.
   */
  | { kind: 'ignore_at'; file: string; line?: number }
  | { kind: 'explain' } // thread reply: deep-dive explanation of the finding
  | { kind: 'resolve_conflicts' } // attempt to resolve merge conflicts
  | { kind: 'auto_apply'; enabled: boolean }
  | { kind: 'rate_limit' } // show remaining hourly/monthly quota without starting a review
  | { kind: 'help' }
  | { kind: 'prompt'; instruction: string }; // free-form AI instruction (ask / change)

export function commandTrigger(): string {
  return loadReviewRuntimeConfig().commandTrigger;
}

/**
 * Parse an `@orvex …` command out of a PR / review comment body.
 * Returns null when the comment doesn't address the bot.
 */
export function parseOrvexCommand(body: string, trigger = commandTrigger()): OrvexCommand | null {
  // Strip fenced code blocks and markdown blockquote lines BEFORE searching — a
  // quoted prior comment (GitHub "Quote reply" produces `> @orvex fix all`) or a
  // fenced mention must NOT re-trigger a command (esp. destructive `fix all`).
  const removeFencedBlocks = (source: string, fence: '`' | '~'): string =>
    source.replace(
      new RegExp(
        `(^|\\n)[ \\t]*${fence}{3,}[^\\n]*(?:\\n|$)[\\s\\S]*?(?:\\n[ \\t]*${fence}{3,}[ \\t]*(?:\\n|$)|$)`,
        'g',
      ),
      '$1 ',
    );
  const scanBody = removeFencedBlocks(removeFencedBlocks(body, '`'), '~').replace(
    /^\s*>.*$/gm,
    ' ',
  );
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
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/ (please|pls|thanks|thank you)$/, '')
    .trim();

  if (normalized === '' || normalized === 'help') return { kind: 'help' };
  if (
    normalized === 'rate limit' ||
    normalized === 'rate-limit' ||
    normalized === 'ratelimit' ||
    normalized === 'quota' ||
    normalized === 'usage' ||
    normalized === 'reviews remaining' ||
    normalized === 'remaining'
  ) {
    return { kind: 'rate_limit' };
  }
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
  // `ignore <path>` / `ignore <path>:<line>` — matched on the RAW rest so the
  // path keeps its original case (paths are case-sensitive; `normalized` is
  // lowercased and would never match a file named `Auth.ts`).
  {
    const at = /^(?:ignore|dismiss)\s+(?:this\s+)?([^\s:][^\s]*?)(?::(\d+))?$/i.exec(
      rest.replace(/[.!]+$/, '').trim(),
    );
    if (at) {
      return at[2]
        ? { kind: 'ignore_at', file: at[1], line: Number(at[2]) }
        : { kind: 'ignore_at', file: at[1] };
    }
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

  // Near-miss quota asks ("check rate limit", "what is my usage") must NOT fall
  // through to `prompt` via verbs like check/how — that burns paid LLM quota.
  // Runs AFTER known commands so "fix … usage …" / "review the quota …" stay
  // fix/review/prompt, not a silent rate_limit hijack.
  if (looksLikeRateLimitAsk(normalized)) return { kind: 'rate_limit' };

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

/** Quota-status phrasing that is not an exact alias — keep narrow to avoid hijacking real prompts. */
function looksLikeRateLimitAsk(normalized: string): boolean {
  // Never steal a command that already starts as a known imperative.
  if (
    /^(fix|review|re-review|rereview|deep|ignore|dismiss|explain|why|resolve|auto[- ]?apply)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  // "how/check … rate limit/quota …" is often an IMPLEMENTATION prompt
  // ("how to add rate limits", "check if the rate limit middleware handles X").
  // Only treat how/check as quota-status when the ask is clearly ABOUT the
  // account's remaining allowance — not building/inspecting product code.
  if (/^(how|check)\b/.test(normalized)) {
    if (
      /\b(to |should |implement|add|handle|middleware|endpoint|module|enforce|for this|in this|whether|if the)\b/.test(
        normalized,
      )
    ) {
      return false;
    }
  }
  // Require ask framing — bare "quota"/"usage" inside a code instruction is a prompt.
  if (
    /^(check|show|get|what|how|am i)\b/.test(normalized) &&
    /\b(rate[- ]?limits?|quota)\b/.test(normalized)
  ) {
    return true;
  }
  // Catalog lists `usage` as a rate-limit alias; ask-framed "check/show usage"
  // must not fall through to paid prompt via the actionable-verb gate.
  // Keep narrow ("check the usage of this cache" stays a prompt).
  if (/^(check|show|get)\s+(my\s+|our\s+)?usage\b/.test(normalized)) return true;
  if (/^(my|our)\s+(rate[- ]?limits?|quota|usage)\b/.test(normalized)) return true;
  if (/\b(my|our)\s+usage\b/.test(normalized)) return true;
  if (/\breviews?\s+(remaining|left)\b/.test(normalized)) return true;
  if (/\bremaining\s+reviews?\b/.test(normalized)) return true;
  return false;
}
import { loadReviewRuntimeConfig } from '@orvex-review/config';
