const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: 'ghp_[REDACTED]' },
  { pattern: /\bgho_[A-Za-z0-9]{20,}\b/g, replacement: 'gho_[REDACTED]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: 'github_pat_[REDACTED]' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: 'sk-[REDACTED]' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: 'AKIA[REDACTED]' },
  { pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: 'eyJ[JWT_REDACTED]' },
  { pattern: /(password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\n]{8,}['"]/gi, replacement: '$1=[REDACTED]' },
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
