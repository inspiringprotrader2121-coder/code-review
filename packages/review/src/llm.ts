import Anthropic from '@anthropic-ai/sdk';
import { buildUserPrompt, loadVelatrixRules } from './prompt.js';
import { redactPatch } from './redact.js';
import { LlmReviewResponseSchema, type Finding, type LlmReviewResponse, type ReviewableFile } from './types.js';

export interface LlmReviewOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
}

export async function runLlmReview(
  files: ReviewableFile[],
  opts: LlmReviewOptions,
): Promise<LlmReviewResponse> {
  const reviewable = files.filter((f) => f.patch && f.status !== 'removed');
  if (reviewable.length === 0) {
    return {
      findings: [],
      summary: 'No reviewable text diff in this PR (binary, lockfiles, or generated paths skipped).',
    };
  }

  const redactedFiles = reviewable.map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: redactPatch(f.patch),
  }));

  const client = new Anthropic({ apiKey: opts.apiKey });
  const system = loadVelatrixRules();
  const user = buildUserPrompt(redactedFiles);

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content');
  }

  const json = extractJson(textBlock.text);
  const parsed = LlmReviewResponseSchema.parse(json);

  return {
    ...parsed,
    findings: parsed.findings.slice(0, 8),
  };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

export function formatReviewComment(
  findings: Finding[],
  meta: { owner: string; repo: string; pr: number; headSha: string; summary?: string },
): string {
  const shortSha = meta.headSha.slice(0, 7);
  const lines: string[] = [
    '## Velatrix Review',
    '',
    `Reviewed \`${meta.owner}/${meta.repo}#${meta.pr}\` @ \`${shortSha}\`.`,
    '',
  ];

  if (meta.summary) {
    lines.push(meta.summary, '');
  }

  if (findings.length === 0) {
    lines.push('No issues found in the changed hunks.');
    return lines.join('\n');
  }

  lines.push('| Severity | File | Message |', '| --- | --- | --- |');
  for (const f of findings) {
    const file = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
    const msg = f.message.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${f.severity} | ${file} | ${msg} |`);
  }

  lines.push('', '<details><summary>Suggestions</summary>', '');
  for (const f of findings) {
    if (!f.suggestion) continue;
    lines.push(`**${f.file}** — ${f.message}`, '', f.suggestion, '');
  }
  lines.push('</details>');

  return lines.join('\n');
}
