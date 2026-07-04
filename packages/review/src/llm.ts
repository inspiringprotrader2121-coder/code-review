import { buildUserPrompt, loadOrvexRules, type ReviewPromptContext } from './prompt.js';
import { redactPatch, redactSecrets } from './redact.js';
import { llmChat } from './llm-client.js';
import type { ReviewFinding } from './finding.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from './types.js';

export interface LlmReviewOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint (e.g. MiniMax); omit to use Anthropic */
  baseUrl?: string;
  maxTokens?: number;
  /** cross-file context: repo tree + imported files */
  context?: ReviewPromptContext;
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

  // all file contents leave the box — same secret redaction as patches
  const redactAll = (files?: Array<{ path: string; content: string }>) =>
    files?.map((f) => ({ ...f, content: redactSecrets(f.content) }));
  const context = opts.context
    ? {
        treePaths: opts.context.treePaths,
        related: redactAll(opts.context.related),
        dependents: redactAll(opts.context.dependents),
        changedContents: redactAll(opts.context.changedContents),
      }
    : undefined;

  const system = loadOrvexRules();
  const user = buildUserPrompt(redactedFiles, context);

  const call = (thinking?: boolean) =>
    llmChat(system, user, {
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      maxTokens: opts.maxTokens ?? 4096,
      json: true,
      thinking,
    });

  let text: string;
  try {
    text = await call();
  } catch (err) {
    // reasoning can truncate/time out on huge prompts — retry once without it
    // so a review still lands rather than failing outright.
    console.warn('[llm] review call failed, retrying without reasoning:', (err as Error).message);
    text = await call(false);
  }

  const json = extractJson(text);
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(json));

  return {
    ...parsed,
    findings: parsed.findings.slice(0, 8).map((f) => ({
      ...f,
      ruleId: f.ruleId ?? `llm.${f.category}`,
    })),
  };
}

const SEVERITY_MAP: Record<string, 'P1' | 'P2' | 'P3' | 'info'> = {
  p1: 'P1', critical: 'P1', blocker: 'P1', severe: 'P1', error: 'P1',
  p2: 'P2', high: 'P2', major: 'P2', warning: 'P2', warn: 'P2',
  p3: 'P3', medium: 'P3', moderate: 'P3', low: 'P3', minor: 'P3',
  info: 'info', informational: 'info', note: 'info', nit: 'info', suggestion: 'info',
};

function coerceSeverity(v: unknown): 'P1' | 'P2' | 'P3' | 'info' {
  return SEVERITY_MAP[String(v ?? '').toLowerCase().trim()] ?? 'P3';
}

/** Reduce a category to a short kebab slug (≤3 words); default 'general'. */
function normalizeCategory(raw: string | undefined): string {
  if (!raw) return 'general';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 3)
    .join('-');
  return slug || 'general';
}

function pickString(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const val = o[k];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return undefined;
}

/**
 * Normalize a raw LLM response into our schema. Models (MiniMax especially)
 * vary the severity vocabulary (critical/high/medium…) and field names
 * (description/type/…), so map the common variants and drop unusable items
 * instead of hard-failing schema validation on the whole review.
 */
export function normalizeLlmResponse(json: unknown): unknown {
  const root = (json ?? {}) as Record<string, unknown>;
  const rawFindings = Array.isArray(root.findings)
    ? root.findings
    : Array.isArray(json)
      ? (json as unknown[])
      : Array.isArray(root.issues)
        ? root.issues
        : [];

  const findings = (rawFindings as unknown[])
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const f = raw as Record<string, unknown>;
      const message = pickString(f, 'message', 'description', 'detail', 'title', 'issue', 'problem', 'summary', 'comment');
      const file = pickString(f, 'file', 'path', 'filename', 'filePath', 'file_path');
      if (!message || !file) return null;

      const lineRaw = f.line ?? f.line_number ?? f.lineNumber ?? f.startLine;
      const line = typeof lineRaw === 'number' ? lineRaw : Number.isFinite(Number(lineRaw)) ? Number(lineRaw) : undefined;
      const confRaw = f.confidence ?? f.score;
      const confidence = typeof confRaw === 'number' ? confRaw : Number.isFinite(Number(confRaw)) ? Number(confRaw) : 0.7;

      return {
        file,
        line: line && line > 0 ? line : undefined,
        severity: coerceSeverity(f.severity ?? f.priority ?? f.level ?? f.impact),
        // category is a short slug, not a sentence — models sometimes stuff the
        // whole title here, which mangles the ruleId (llm.<category>) and header.
        category: normalizeCategory(pickString(f, 'category', 'type', 'rule', 'kind')),
        message,
        suggestion: pickString(f, 'suggestion', 'fix', 'recommendation', 'remediation'),
        originalCode: pickString(f, 'originalCode', 'original_code', 'original', 'before'),
        fixedCode: pickString(f, 'fixedCode', 'fixed_code', 'replacement', 'after'),
        confidence: Math.max(0, Math.min(1, confidence)),
        ruleId: pickString(f, 'ruleId', 'rule_id'),
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  return { findings, summary: pickString(root, 'summary', 'overview') };
}

export function llmFindingsToReviewFindings(findings: LlmReviewResponse['findings']): ReviewFinding[] {
  return findings.map((f) => ({
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    message: f.message,
    suggestion: f.suggestion,
    originalCode: f.originalCode,
    fixedCode: f.fixedCode,
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
