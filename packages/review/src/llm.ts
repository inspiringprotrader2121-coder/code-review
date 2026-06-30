import Anthropic from '@anthropic-ai/sdk';
import { buildUserPrompt, loadVelatrixRules } from './prompt.js';
import { redactPatch } from './redact.js';
import type { ReviewFinding } from './finding.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from './types.js';

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
    findings: parsed.findings.slice(0, 8).map((f) => ({
      ...f,
      ruleId: f.ruleId ?? `llm.${f.category}`,
    })),
  };
}

export function llmFindingsToReviewFindings(findings: LlmReviewResponse['findings']): ReviewFinding[] {
  return findings.map((f) => ({
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    message: f.message,
    suggestion: f.suggestion,
    confidence: f.confidence,
    ruleId: f.ruleId ?? `llm.${f.category}`,
  }));
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(raw);
}

// backwards compat
export { formatReviewBody as formatReviewComment } from './format.js';
