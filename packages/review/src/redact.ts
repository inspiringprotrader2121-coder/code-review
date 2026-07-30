const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // PEM private-key blocks (multi-line) — redact the whole block.
  {
    // Terminate on the END marker OR on end-of-input. Context files are CLIPPED
    // to a byte budget BEFORE redaction runs (repo-context clip(), pipeline
    // per-file slice), so a key straddling the cut lost its `-----END-----`,
    // failed to match, and shipped its header + first base64 lines to the model
    // in clear. Also covers PGP's `PRIVATE KEY BLOCK` armor.
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----|$)/g,
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
      // Negative lookahead on TS/JS type names: `hashPassword(password: string)`
      // was being rewritten to `password: [REDACTED]`, erasing the signature of
      // the very auth code a reviewer needs to read. A type is never a secret.
      /(password|passwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|token)(\s*[:=]\s*)(?!(?:string|number|boolean|any|unknown|never|void|object|symbol|bigint|null|undefined|true|false|Promise|Array|Record|Map|Set|Buffer|Date)\b)([^\s'"#;,]{6,})/gi,
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

  // ——— INFRA/CONFIG FILE SHAPES ———
  // Retrieval now pulls UNCHANGED yaml/tfvars/properties/conf/k8s files into the
  // prompt, and those hold credentials in shapes the rules above miss: the
  // keyword must sit immediately before the separator, and the SCREAMING_SNAKE
  // rule is uppercase-only. So `secret_key_base:`, `vault_db_pw:`,
  // `mail.smtp.pass=` and space-delimited nginx directives all shipped in clear.
  // Over-redaction is safe here; under-redaction sends a live credential to a
  // third-party model.

  // Lowercase / dotted / nested config keys: `secret_key_base: x`,
  // `db.password = x`, `ldap.bind.pwd: x`, `redis_auth = x`, `admin_pass: x`.
  {
    // ANCHORED to the start of a line (config files put the key there; code puts
    // `const `/`return ` in front) and BOUNDED on both sides. The first draft used
    // an unanchored `[A-Za-z0-9_.-]*` on each side, which (a) backtracked
    // quadratically — 50 kB of hex took 6.3s of BLOCKED event loop, attacker-
    // controlled via PR content — and (b) matched ordinary code, rewriting
    // `const passwordOk = verifyPassword(password, hash);` to `= [REDACTED],`
    // and destroying the security-critical lines a reviewer must see.
    // `()` are excluded from the value so a function call can never be a "secret".
    pattern:
      /^([-+ \t]*[A-Za-z0-9_.-]{0,64}(?:secret|password|passwd|passphrase|pwd|[._]pw|[._]auth|apikey|api[_-]key|private[_-]key|access[_-]key|credential|[._]pass)[A-Za-z0-9_.-]{0,32})([ \t]*[:=][ \t]*)(['"]?)([^\s'"#;,(){}]{6,})\3/gim,
    replacement: '$1$2[REDACTED]',
  },
  // Kubernetes long-form env: `- name: DB_PASSWORD` then `value: <secret>` on the
  // next line. Neither line matches on its own; the pairing is the signal.
  {
    pattern:
      // `\s*[\r\n]+\s*` is a 3-way ambiguous split of one whitespace run and
      // backtracked cubically. Use explicit, unambiguous line/indent classes.
      // `[-+ \t]*` tolerates diff prefixes — the first draft missed patches,
      // which are the primary payload of every review.
      /^([-+ \t]*-[ \t]*name:[ \t]*[A-Za-z0-9_]*(?:SECRET|KEY|TOKEN|PASS|PWD|CRED|AUTH)[A-Za-z0-9_]*[ \t]*\r?\n[-+ \t]*value:[ \t]*)(['"]?)([^\s'"\r\n]{4,})\2/gim,
    replacement: '$1[REDACTED]',
  },
  // Space-delimited directives (nginx, Apache, systemd): every rule above needs a
  // `:` or `=`, so `proxy_set_header X-Internal-Token abc123;` passed straight
  // through. Require a long value so ordinary directives aren't touched.
  {
    // BOUNDED quantifiers. Unbounded `[A-Za-z0-9_-]*` on BOTH sides of the
    // alternation backtracks quadratically: 'a-b_' repeated measured
    // 5kB=41ms / 20kB=669ms / 80kB=9.7s of BLOCKED event loop, and the input is
    // attacker-controlled PR file content. A real directive key is short.
    pattern: /\b([A-Za-z0-9_-]{0,48}(?:token|secret|apikey|api[_-]key|password|passwd)[A-Za-z0-9_-]{0,24})([ \t]+)([^\s;{}'"]{12,})([ \t]*;)/gi,
    replacement: '$1$2[REDACTED]$4',
  },
  // Base64-wrapped PEM (k8s Secret `tls.key`, `ca.crt`): the ASCII-header rule
  // can't see it. `LS0tLS1CRUdJTi` is base64("-----BEGIN").
  // `\s` inside the class made this greedily eat following YAML keys/paragraphs.
  // Match the base64 run itself, optionally continued on further indented lines.
  { pattern: /\bLS0tLS1CRUdJTi[A-Za-z0-9+/=]{20,}(?:[ \t]*\r?\n[ \t]+[A-Za-z0-9+/=]+)*/g, replacement: '[BASE64_PRIVATE_KEY_REDACTED]' },
  // JSON / dict-quoted keys: `"password": "x"`, `'client_secret': 'x'`. The
  // quote between the key and the colon defeats every rule above. Bounded
  // quantifiers only — an unbounded prefix here was a measured ReDoS.
  {
    pattern:
      /(["'])([A-Za-z0-9_.-]{0,64}(?:secret|password|passwd|passphrase|pwd|token|apikey|api[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]{0,32})\1(\s*:\s*)(["'])([^"'\n]{4,})\4/gi,
    replacement: '$1$2$1$3$4[REDACTED]$4',
  },
  // Sentry/webhook DSNs carry the key in the URL userinfo.
  { pattern: /\bhttps?:\/\/[A-Za-z0-9]{16,}@[A-Za-z0-9.-]+\/[0-9]+/g, replacement: '[DSN_REDACTED]' },
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
