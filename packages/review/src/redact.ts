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
  // key=value (UNQUOTED) — the common .env / CI leak. NO leading \b on purpose:
  // real secrets use prefixed SCREAMING_SNAKE keys (JWT_SECRET, DB_PASSWORD,
  // AWS_SECRET_ACCESS_KEY) where `_` is a word char, so a leading \b never
  // matched them and shipped the value to the model. Matching the keyword as a
  // substring of the key is correct — over-redaction is safe, under-redaction is
  // the bug. The assignment + 6+ char value guard keeps ordinary prose out.
  {
    pattern:
      /(password|passwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|token)(\s*[:=]\s*)([^\s'"#;,]{6,})/gi,
    replacement: '$1$2[REDACTED]',
  },
  // SCREAMING_SNAKE env secret where the keyword is NOT the last token before `=`
  // — e.g. SECRET_KEY=, SECRET_KEY_BASE=, PRIVATE_KEY=, ENCRYPTION_KEY=,
  // SIGNING_KEY=, MASTER_KEY=, GPG_PASSPHRASE=. The rule above only fires when the
  // keyword ends the key (DB_PASSWORD works, SECRET_KEY doesn't), so these leaked.
  {
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASS(?:WORD|PHRASE)?|CREDENTIALS?|PRIVATE|SIGNING|ENCRYPTION)[A-Z0-9_]*)(\s*[:=]\s*)([^\s'"#;,]{6,})/g,
    replacement: '$1$2[REDACTED]',
  },
  // Authorization: Bearer <token> (and JSON "authorization": "Bearer …").
  {
    pattern: /\b([Bb]earer\s+)[A-Za-z0-9._~+/-]{16,}=*/g,
    replacement: '$1[REDACTED]',
  },
  // Connection-string / URL credentials: scheme://[user]:PASSWORD@host — redact
  // the password. Username is OPTIONAL ([^\s:@/]*) so redis AUTH's userless form
  // `redis://:pass@host` (and many managed URLs) is caught, not just `user:pass@`.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]{3,})@/gi,
    replacement: '$1[REDACTED]@',
  },
  // Slack incoming-webhook URLs (the path IS the secret).
  {
    pattern: /(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g,
    replacement: '$1[REDACTED]',
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
