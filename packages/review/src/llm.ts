import { buildUserPrompt, loadVelatrixRules } from './prompt.js';
import { redactPatch } from './redact.js';
import type { ReviewFinding } from './finding.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from './types.js';

export interface LlmReviewOptions {
  apiKey: string;
  baseUrl: string;
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

  const system = loadVelatrixRules();
  const user = buildUserPrompt(redactedFiles);

  const response = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
    model: opts.model,
      max_completion_tokens: opts.maxTokens ?? 4096,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorBody.slice(0, 500)}`);
  }

  const completion = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = completion.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('LLM returned no text content');
  }

  const json = extractJson(stripThinking(text));
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

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// backwards compat
export { formatReviewBody as formatReviewComment } from './format.js';
