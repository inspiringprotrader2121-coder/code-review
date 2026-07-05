const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // PEM private-key blocks (multi-line) — redact the whole block.
  {
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replacement: '[PRIVATE_KEY_REDACTED]',
  },
  // GitHub tokens.
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: 'ghp_[REDACTED]' },
  { pattern: /\bgho_[A-Za-z0-9]{20,}\b/g, replacement: 'gho_[REDACTED]' },
  { pattern: /\bghs_[A-Za-z0-9]{20,}\b/g, replacement: 'ghs_[REDACTED]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: 'github_pat_[REDACTED]' },
  // OpenAI / Anthropic — allow `-` and `_` so `sk-ant-…` and project keys are
  // caught (the old `sk-[A-Za-z0-9]` stopped at the hyphen after `sk-ant`).
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, replacement: 'sk-[REDACTED]' },
  // Stripe secret / restricted keys.
  { pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replacement: '[STRIPE_KEY_REDACTED]' },
  // Google API keys (real keys are AIza + 35 chars; match leniently for safety).
  { pattern: /\bAIza[A-Za-z0-9_-]{30,}/g, replacement: 'AIza[REDACTED]' },
  // Slack tokens.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: 'xox[REDACTED]' },
  // AWS access key id.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: 'AKIA[REDACTED]' },
  // JWTs.
  { pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: 'eyJ[JWT_REDACTED]' },
  // key = "value" (quoted).
  {
    pattern:
      /(password|passwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|token)\s*[:=]\s*['"][^'"\n]{8,}['"]/gi,
    replacement: '$1=[REDACTED]',
  },
  // key=value (UNQUOTED) — the common .env / CI leak the quoted rule missed.
  // Requires an assignment and an 8+ char non-whitespace value, so ordinary
  // prose ("token: the next step") won't trip it.
  {
    pattern:
      /\b(password|passwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token)\b(\s*[:=]\s*)([^\s'"#;,]{8,})/gi,
    replacement: '$1$2[REDACTED]',
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactPatch(patch: string | undefined): string | undefined {
  if (!patch) return patch;
  return redactSecrets(patch);
}
