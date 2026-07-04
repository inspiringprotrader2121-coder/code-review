import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_RULES = `You are Orvex Review, a code review bot for Velatrix-Cloud (IPTV / streaming SaaS).

Focus on real defects and security issues. Skip style nits unless they hide bugs.

## Priority areas
- Auth, JWT, session refresh, RBAC, tenant isolation
- IPTV line/stream abuse, restream detection, fail-closed security paths
- SQL injection, XSS, SSRF, secrets in code
- Race conditions on billing, credits, coupons, PPV
- Nginx / agent / playback URL signing mistakes
- Audit markdown docs: never put testPathPatterns inside table cells; use fenced bash blocks

## Severity
- P1: security, data loss, auth bypass, production outage
- P2: logic bugs, missing validation, tenant leak risk
- P3: maintainability issues that likely cause bugs
- info: suggestions only when high confidence

## Output rules
- Only report issues in the provided diff hunks
- Max 8 findings; prefer fewer, higher-quality items
- confidence 0.0–1.0; omit low-confidence noise
- When you can propose a concrete code fix, include "originalCode" (the EXACT
  affected source line(s), copied verbatim from the diff's new side) and
  "fixedCode" (the replacement). Keep originalCode as small as possible —
  ideally the single flagged line. Omit both when unsure.
- Respond with JSON only, matching the schema`;

export function loadOrvexRules(): string {
  const candidates = [
    path.resolve(process.cwd(), 'rules/orvex-rules.md'),
    path.resolve(__dirname, '../../../rules/orvex-rules.md'),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8');
    }
  }

  return DEFAULT_RULES;
}

export interface ReviewPromptContext {
  /** repo file paths at the reviewed sha */
  treePaths?: string[];
  /** files the changed code imports, for cross-file reasoning */
  related?: Array<{ path: string; content: string }>;
  /** files that import the changed code (reverse dependencies) */
  dependents?: Array<{ path: string; content: string }>;
  /** full contents of the changed files (hunks lack surrounding logic) */
  changedContents?: Array<{ path: string; content: string }>;
}

const MAX_TREE_PATHS = 300;
const MAX_CHANGED_CHARS = 160_000;
const MAX_RELATED_CHARS = 110_000;

export function buildUserPrompt(
  files: Array<{ filename: string; status: string; patch?: string }>,
  context?: ReviewPromptContext,
): string {
  const sections = files.map((f) => {
    const patch = f.patch ?? '(no patch — binary or too large)';
    return `### ${f.filename} (${f.status})\n\`\`\`diff\n${patch}\n\`\`\``;
  });

  const parts = [
    'Review these changed files from a pull request.',
    'Return JSON: { "findings": [...], "summary": "one paragraph" }',
    '',
    ...sections,
  ];

  if (context?.changedContents?.length) {
    parts.push(
      '',
      '## Full content of the changed files',
      'The diff above shows only hunks. Read the full files before judging: logic elsewhere',
      'in the same file (runners, guards, error handling) often changes whether a hunk is a bug.',
    );
    let used = 0;
    for (const f of context.changedContents) {
      const block = `\n### ${f.path} (full file)\n\`\`\`\n${f.content}\n\`\`\``;
      if (used + block.length > MAX_CHANGED_CHARS) break;
      parts.push(block);
      used += block.length;
    }
  }

  if (context?.related?.length || context?.dependents?.length) {
    parts.push(
      '',
      '## Cross-file context (CONTEXT ONLY — do not report issues in these files themselves)',
      'Imported files show callee contracts; dependent files show callers the diff may break.',
      'Only report findings whose *cause* is in the diff; anchor every finding to a changed file.',
    );
    let used = 0;
    for (const r of context.related ?? []) {
      const block = `\n### ${r.path} (imported by changed code)\n\`\`\`\n${r.content}\n\`\`\``;
      if (used + block.length > MAX_RELATED_CHARS) break;
      parts.push(block);
      used += block.length;
    }
    for (const d of context.dependents ?? []) {
      const block = `\n### ${d.path} (imports the changed code — check for breakage)\n\`\`\`\n${d.content}\n\`\`\``;
      if (used + block.length > MAX_RELATED_CHARS) break;
      parts.push(block);
      used += block.length;
    }
  }

  if (context?.treePaths?.length) {
    const shown = context.treePaths.slice(0, MAX_TREE_PATHS);
    parts.push(
      '',
      '## Repository structure (for orientation)',
      '```',
      shown.join('\n'),
      shown.length < context.treePaths.length ? `… ${context.treePaths.length - shown.length} more files` : '',
      '```',
    );
  }

  return parts.join('\n');
}
