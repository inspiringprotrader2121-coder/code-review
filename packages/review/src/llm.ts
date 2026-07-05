import { buildUserPrompt, loadOrvexRules, type ReviewPromptContext } from './prompt.js';
import { redactPatch, redactSecrets } from './redact.js';
import { llmChat, extractJsonLoose } from './llm-client.js';
import type { ReviewFinding } from './finding.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from './types.js';

/**
 * A rate-limit / transport failure (429, token-plan quota, network, timeout) —
 * retryable, and crucially NOT a clean review. Callers should FAIL the review on
 * these (so it retries when quota recovers) rather than posting an empty result.
 * A model returning unparseable text is a different case (degrade to empty).
 */
export function isTransientLlmError(message: string): boolean {
  return /\b429\b|rate.?limit|quota|token plan|request failed|fetch failed|stalled|timed?\s?out|econn|socket hang/i.test(
    message,
  );
}

/**
 * Summary returned when the model produced an UNPARSEABLE response (not a clean
 * review). Callers check for this to avoid posting a contradictory
 * "could not be completed" + "✅ no issues found" review: if every pass degrades
 * to this, the whole review should FAIL/retry, not report a false clean pass.
 */
export const REVIEW_INCOMPLETE_SUMMARY =
  'Review could not be completed: the model returned an unparseable response. Re-run `@orvex review` to try again.';

export interface LlmReviewOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint (e.g. MiniMax); omit to use Anthropic */
  baseUrl?: string;
  maxTokens?: number;
  /** cross-file context: repo tree + imported files */
  context?: ReviewPromptContext;
  /** token-usage callback for cost tracking (per model call) */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
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
        // PR intent must survive the rebuild — it's what stops "you removed X"
        // findings on deliberate changes. (Was silently dropped here before.)
        prTitle: opts.context.prTitle,
        prBody: opts.context.prBody,
        treePaths: opts.context.treePaths,
        related: redactAll(opts.context.related),
        dependents: redactAll(opts.context.dependents),
        changedContents: redactAll(opts.context.changedContents),
        others: redactAll(opts.context.others),
      }
    : undefined;

  const system = loadOrvexRules();
  const user = buildUserPrompt(redactedFiles, context);

  const call = (thinking: boolean) =>
    llmChat(system, user, {
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      // no cap — pass through (undefined → client's high ceiling) so the review
      // has room for full reasoning + detailed findings with fix code
      maxTokens: opts.maxTokens,
      json: true,
      thinking,
      onUsage: opts.onUsage,
    });

  // Deep reasoning ON by default: both provider branches stream with an
  // inactivity/keep-alive timer, so a long think can't drop the connection.
  // ORVEX_REVIEW_THINKING=0 opts out; a failed reasoning call still retries
  // once without reasoning below so a review is never lost to a thinking bug.
  const reviewThinking = process.env.ORVEX_REVIEW_THINKING !== '0';
  const parseReview = (text: string) =>
    LlmReviewResponseSchema.parse(normalizeLlmResponse(extractJsonLoose(text)));

  // Both the model call AND the JSON extraction/validation are inside the retry:
  // an unparseable payload (e.g. the model wrapping its answer in a ```bash
  // block) must retry without reasoning, then degrade gracefully — never crash
  // the whole review job the way an uncaught JSON.parse used to.
  let parsed: LlmReviewResponse;
  try {
    parsed = parseReview(await call(reviewThinking));
  } catch (err) {
    console.warn('[llm] review call/parse failed, retrying without reasoning:', (err as Error).message);
    try {
      parsed = parseReview(await call(false));
    } catch (err2) {
      const msg = (err2 as Error).message;
      // A rate-limit / transport failure is NOT a clean review — propagate it so
      // the job FAILS (and can be retried when quota recovers) instead of silently
      // posting an empty "0 findings" review. Only a genuine unparseable model
      // payload degrades to empty.
      if (isTransientLlmError(msg)) throw err2;
      console.error('[llm] review unparseable after retry — returning empty:', msg);
      return { findings: [], summary: REVIEW_INCOMPLETE_SUMMARY };
    }
  }

  // Generous backstop against a runaway model, not a quality gate — the rules
  // prompt and the noise/verification passes control real finding volume.
  const maxFindings = Number(process.env.ORVEX_MAX_FINDINGS ?? 25);
  return {
    ...parsed,
    findings: parsed.findings.slice(0, maxFindings).map((f) => ({
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

// backwards compat
export { formatReviewBody as formatReviewComment } from './format.js';
