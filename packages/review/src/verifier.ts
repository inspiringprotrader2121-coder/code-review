import { z } from 'zod';
import { llmChat } from './llm-client.js';
import { redactSecrets } from './redact.js';
import type { ReviewFinding } from './finding.js';

export interface VerifierOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** PR title + description, so the verifier can reject intentional-change findings */
  prIntent?: string;
}

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.number().int(),
      verdict: z.enum(['confirmed', 'rejected']),
      reason: z.string().optional(),
      severity: z.enum(['P1', 'P2', 'P3', 'info']).optional(),
    }),
  ),
});

export interface VerifiedFindings {
  kept: ReviewFinding[];
  dropped: Array<{ finding: ReviewFinding; reason: string }>;
}

const MAX_VERIFY_FILE_CHARS = 40_000;
const MAX_VERIFY_TOTAL_CHARS = 160_000;

/**
 * Adversarial second pass: a skeptical reviewer tries to REFUTE each candidate
 * finding against the full file contents. Findings survive only if the code
 * shown actually supports them. This is what kills plausible-but-wrong
 * findings (e.g. flagging a hazard that a runner 200 lines below the diff
 * explicitly handles). Fails open: on any error the original findings pass
 * through, so verification can never lose real findings.
 */
export async function verifyFindings(
  findings: ReviewFinding[],
  files: Array<{ path: string; content: string }>,
  opts: VerifierOptions,
): Promise<VerifiedFindings> {
  if (findings.length === 0) return { kept: [], dropped: [] };

  const findingList = findings
    .map(
      (f, i) =>
        `[${i}] ${f.severity} ${f.file}${f.line ? `:${f.line}` : ''} (${f.ruleId})\n${f.message}`,
    )
    .join('\n\n');

  const fileBlocks: string[] = [];
  let used = 0;
  const wanted = new Set(findings.map((f) => f.file));
  const ordered = [...files.filter((f) => wanted.has(f.path)), ...files.filter((f) => !wanted.has(f.path))];
  for (const f of ordered) {
    const body = redactSecrets(f.content.slice(0, MAX_VERIFY_FILE_CHARS));
    const block = `### ${f.path}\n\`\`\`\n${body}\n\`\`\``;
    if (used + block.length > MAX_VERIFY_TOTAL_CHARS) break;
    fileBlocks.push(block);
    used += block.length;
  }

  const user = [
    opts.prIntent ? `## What this PR intends to do\n${opts.prIntent.slice(0, 3000)}\n` : '',
    'Candidate code-review findings:',
    '',
    findingList,
    '',
    'Full source files:',
    ...fileBlocks,
    '',
    'For EACH finding, actively try to REFUTE it using the code above. Reject if ANY apply:',
    '- The finding describes a change that IS the point of this PR (intentional removal/behavior change).',
    '- The claimed hazard is already handled elsewhere in the file (guards, runners, error handling, idempotency).',
    "- The claim is factually wrong about the code — e.g. it attributes a pre-existing throw/behavior to this PR,",
    '  or claims code exists/does something the source does not show.',
    '- It depends on code, callers, config, or deployment/runtime state you cannot see in the source.',
    '- The failure scenario is not reachable with concrete inputs you can name.',
    '- It is a duplicate, or a style/docs/release-note observation dressed up as a bug.',
    'If it survives, you may correct the severity (P1 = provable security/data-loss/outage with a named trigger).',
    '',
    'Respond with JSON only: { "verdicts": [{ "id": <number>, "verdict": "confirmed"|"rejected", "reason": "<short>", "severity"?: "P1"|"P2"|"P3"|"info" }] }',
    'Include a verdict for every id. When in doubt, reject — a missed nit is cheaper than a false alarm.',
  ].join('\n');

  let parsed: z.infer<typeof VerdictSchema>;
  try {
    const text = await llmChat(
      'You are a skeptical principal engineer verifying code-review findings before they are posted. You respond with strict JSON only.',
      user,
      { apiKey: opts.apiKey, model: opts.model, baseUrl: opts.baseUrl, maxTokens: 8000, json: true },
    );
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = VerdictSchema.parse(JSON.parse(fenced ? fenced[1].trim() : text.trim()));
  } catch {
    return { kept: findings, dropped: [] }; // fail open
  }

  const byId = new Map(parsed.verdicts.map((v) => [v.id, v]));
  const kept: ReviewFinding[] = [];
  const dropped: Array<{ finding: ReviewFinding; reason: string }> = [];
  findings.forEach((f, i) => {
    const v = byId.get(i);
    if (!v || v.verdict === 'confirmed') {
      kept.push(v?.severity ? { ...f, severity: v.severity } : f);
    } else {
      dropped.push({ finding: f, reason: v.reason ?? 'rejected by verification' });
    }
  });
  return { kept, dropped };
}

export interface FixCandidate {
  file: string;
  findingMessage: string;
  originalCode: string;
  fixedCode: string;
}

/**
 * Same adversarial pass for fixes, run BEFORE anything is committed: does each
 * proposed change actually address the finding without breaking the
 * surrounding code? Fails open.
 */
export async function verifyFixes(
  candidates: FixCandidate[],
  files: Array<{ path: string; content: string }>,
  opts: VerifierOptions,
): Promise<{ approved: number[]; rejected: Array<{ index: number; reason: string }> }> {
  if (candidates.length === 0) return { approved: [], rejected: [] };

  const list = candidates
    .map(
      (c, i) =>
        `[${i}] ${c.file}\nFinding: ${c.findingMessage.slice(0, 300)}\n--- current code ---\n${c.originalCode}\n--- proposed replacement ---\n${c.fixedCode}`,
    )
    .join('\n\n');

  const fileBlocks: string[] = [];
  let used = 0;
  const wanted = new Set(candidates.map((c) => c.file));
  for (const f of files.filter((x) => wanted.has(x.path))) {
    const block = `### ${f.path}\n\`\`\`\n${redactSecrets(f.content.slice(0, MAX_VERIFY_FILE_CHARS))}\n\`\`\``;
    if (used + block.length > MAX_VERIFY_TOTAL_CHARS) break;
    fileBlocks.push(block);
    used += block.length;
  }

  const user = [
    'Proposed code fixes:',
    '',
    list,
    '',
    'Full source files:',
    ...fileBlocks,
    '',
    'For EACH fix decide: does the replacement correctly address the finding WITHOUT breaking',
    'surrounding behavior (types, control flow, callers visible in the file, error handling)?',
    'Reject fixes that are cosmetic, incomplete, change unrelated behavior, or make the code worse.',
    '',
    'Respond with JSON only: { "verdicts": [{ "id": <number>, "verdict": "confirmed"|"rejected", "reason": "<short>" }] }',
    'Include a verdict for every id. When in doubt, reject — never commit a dubious change.',
  ].join('\n');

  try {
    const text = await llmChat(
      'You are a skeptical principal engineer gating auto-generated fixes before they are committed. You respond with strict JSON only.',
      user,
      { apiKey: opts.apiKey, model: opts.model, baseUrl: opts.baseUrl, maxTokens: 6000, json: true },
    );
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const parsed = VerdictSchema.parse(JSON.parse(fenced ? fenced[1].trim() : text.trim()));
    const approved: number[] = [];
    const rejected: Array<{ index: number; reason: string }> = [];
    candidates.forEach((_, i) => {
      const v = parsed.verdicts.find((x) => x.id === i);
      if (!v || v.verdict === 'confirmed') approved.push(i);
      else rejected.push({ index: i, reason: v.reason ?? 'rejected by verification' });
    });
    return { approved, rejected };
  } catch {
    return { approved: candidates.map((_, i) => i), rejected: [] }; // fail open
  }
}
