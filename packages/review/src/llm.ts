import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { buildUserPrompt, loadOrvexRules, type ReviewPromptContext } from './prompt.js';
import { redactPatch, redactSecrets } from './redact.js';
import {
  llmChat,
  extractJsonLoose,
  isRetryableRateLimit,
  isReviewCancelledError,
  type LlmAttemptEvent,
} from './llm-client.js';
import type { ReviewFinding } from './finding.js';
import type { ModelRunner, ModelTarget, TextModelRunRequest } from './providers/types.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from './types.js';

/**
 * A rate-limit / transport failure (429, token-plan quota, network, timeout) —
 * retryable, and crucially NOT a clean review. Callers should FAIL the review on
 * these (so it retries when quota recovers) rather than posting an empty result.
 * A model returning unparseable text is a different case (degrade to empty).
 */
export function isTransientLlmError(message: string): boolean {
  // Client errors are permanent unless the status explicitly means retry later.
  // Check the complete 4xx range before the broad `request failed` matcher so an
  // unsupported media type (415), validation error (422), etc. cannot be requeued
  // as a transport failure. 408/425/429 are the retryable HTTP exceptions.
  const status =
    /\b(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*(4\d\d)\b/i.exec(message)?.[1] ??
    /\brequest failed\s*\(\s*(4\d\d)\b/i.exec(message)?.[1];
  // Gateways commonly use 402 when the requested output allowance exceeds the
  // current credit balance. That is a quota condition: fail over/retry it rather
  // than misreporting the missing pass as a clean, empty review.
  if (status === '402' && /credit|quota|payment required|insufficient/i.test(message)) return true;
  if (status && !['408', '425', '429'].includes(status)) return false;
  return /\b(408|425|429|5\d\d)\b|rate.?limit|quota|token plan|request failed|fetch failed|stalled|timed?\s?out|wall-clock cap|produced no output|econn|socket hang/i.test(
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
  /** 'responses' for OpenAI gpt-5.x/codex reasoning models */
  api?: 'chat' | 'responses' | 'anthropic';
  /** reasoning effort for /v1/responses models */
  reasoningEffort?: string;
  /** Sampling temperature for deliberately repeated review runs. */
  temperature?: number;
  /** Cancel this review call when its PR closes or merges. */
  signal?: AbortSignal;
  maxTokens?: number;
  /** cross-file context: repo tree + imported files */
  context?: ReviewPromptContext;
  /** token-usage callback for cost tracking (per model call) */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    provider?: string;
    model?: string;
    attemptId?: string;
  }) => void;
  onAttempt?: (event: LlmAttemptEvent) => void;
  /**
   * Explicit provider path. Server workers supply this for public plans so
   * transport is selected by a resolved stage target rather than by URL/api
   * inference. The fields above remain the single legacy ingress shape.
   */
  runner?: ModelRunner<TextModelRunRequest>;
  target?: ModelTarget;
}

export async function runLlmReview(
  files: ReviewableFile[],
  opts: LlmReviewOptions,
): Promise<LlmReviewResponse> {
  const reviewable = files.filter((f) => f.patch && f.status !== 'removed');
  if (reviewable.length === 0) {
    return {
      findings: [],
      summary:
        'No reviewable text diff in this PR (binary, lockfiles, or generated paths skipped).',
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
        others: redactAll(opts.context.others),
        // Must pass through — without this, deep-dive / breadth / investigate
        // lens text never reaches buildUserPrompt.
        extraFocus: opts.context.extraFocus,
      }
    : undefined;

  const system = loadOrvexRules();
  const user = buildUserPrompt(redactedFiles, context);

  const call = (thinking: boolean, temperature = opts.temperature) => {
    if (opts.runner && opts.target) {
      return opts.runner.run({
        system,
        user,
        target: opts.target,
        json: true,
        thinking,
        temperature,
        signal: opts.signal,
        onUsage: opts.onUsage,
        onAttempt: opts.onAttempt,
      });
    }
    // The old option shape remains only for non-migrated callers. Public plan
    // stages use the explicit runner/target branch above.
    return llmChat(system, user, {
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      api: opts.api,
      reasoningEffort: opts.reasoningEffort,
      temperature,
      // no cap — pass through (undefined → client's high ceiling) so the review
      // has room for full reasoning + detailed findings with fix code
      maxTokens: opts.maxTokens,
      json: true,
      thinking,
      signal: opts.signal,
      onUsage: opts.onUsage,
      onAttempt: opts.onAttempt,
    });
  };

  // Production review targets are configured at max effort.
  const reviewThinking = true;
  const parseReview = (text: string) =>
    LlmReviewResponseSchema.parse(normalizeLlmResponse(extractJsonLoose(text)));

  // One discovery request only. llmChat owns its one bounded same-provider
  // rate-limit retry; replaying a complete max-reasoning call for malformed JSON
  // doubled spend without adding evidence. Invalid output degrades visibly and
  // the required-lens gate prevents it from being reported as a clean review.
  let parsed: LlmReviewResponse;
  try {
    parsed = parseReview(await call(reviewThinking));
  } catch (err) {
    if (isReviewCancelledError(err) || opts.signal?.aborted) throw err;
    const message = (err as Error).message;
    // Rate-limit, transport and timeout failures are not clean reviews. Preserve
    // them so provider cooldown/admission and the required-pass gate can act.
    if (isTransientLlmError(message) || isRetryableRateLimit(message)) throw err;
    console.error('[llm] review response invalid — returning incomplete without replay:', message);
    return { findings: [], summary: REVIEW_INCOMPLETE_SUMMARY };
  }

  // Generous backstop against a runaway model, not a quality gate — the rules
  // prompt and the noise/verification passes control real finding volume.
  const maxFindings = loadReviewRuntimeConfig().maxFindings;
  // Sort by severity BEFORE the cap so a runaway response keeps the most-severe
  // findings (the old prefix-slice could drop a P1 while keeping info), and LOG
  // any drop so a capped finding is never silently lost.
  const rank = (s: string): number => (s === 'P1' ? 0 : s === 'P2' ? 1 : s === 'P3' ? 2 : 3);
  const sorted = [...parsed.findings].sort((a, b) => rank(a.severity) - rank(b.severity));
  if (sorted.length > maxFindings) {
    console.warn(
      `[llm] capping ${sorted.length} findings to ${maxFindings}; ${sorted.length - maxFindings} lowest-severity dropped`,
    );
  }
  return {
    ...parsed,
    findings: sorted.slice(0, maxFindings).map((f) => ({
      ...f,
      ruleId: f.ruleId ?? `llm.${f.category}`,
    })),
  };
}

// Taxonomy (Codex 2026-07-16): P1=Critical, P2=High, P3=MEDIUM, info=Low/nitpick.
// "medium" must NOT collapse into the same bucket as "low/minor" — a medium bug
// is a real finding the product exists to surface, not a nitpick. low/minor/
// trivial map to `info`; medium/moderate map to P3.
const SEVERITY_MAP: Record<string, 'P1' | 'P2' | 'P3' | 'info'> = {
  p1: 'P1',
  critical: 'P1',
  blocker: 'P1',
  severe: 'P1',
  error: 'P1',
  p2: 'P2',
  high: 'P2',
  major: 'P2',
  warning: 'P2',
  warn: 'P2',
  p3: 'P3',
  medium: 'P3',
  moderate: 'P3',
  mid: 'P3',
  info: 'info',
  informational: 'info',
  note: 'info',
  nit: 'info',
  nitpick: 'info',
  suggestion: 'info',
  low: 'info',
  minor: 'info',
  trivial: 'info',
  small: 'info',
};

function coerceSeverity(v: unknown): 'P1' | 'P2' | 'P3' | 'info' {
  // Unknown/empty severity → `info`, NOT P3. P3 now means MEDIUM (a real bug), so
  // an unrecognized word ("style", "cosmetic", "") is more likely noise than a
  // medium bug — fail toward nitpick, not toward asserting a real finding.
  return (
    SEVERITY_MAP[
      String(v ?? '')
        .toLowerCase()
        .trim()
    ] ?? 'info'
  );
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
      const message = pickString(
        f,
        'message',
        'description',
        'detail',
        'title',
        'issue',
        'problem',
        'summary',
        'comment',
      );
      const file = pickString(f, 'file', 'path', 'filename', 'filePath', 'file_path');
      if (!message || !file) return null;

      const lineRaw = f.line ?? f.line_number ?? f.lineNumber ?? f.startLine;
      const line =
        typeof lineRaw === 'number'
          ? lineRaw
          : Number.isFinite(Number(lineRaw))
            ? Number(lineRaw)
            : undefined;
      const confRaw = f.confidence ?? f.score;
      const confidence =
        typeof confRaw === 'number'
          ? confRaw
          : Number.isFinite(Number(confRaw))
            ? Number(confRaw)
            : 0.7;

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

export function llmFindingsToReviewFindings(
  findings: LlmReviewResponse['findings'],
): ReviewFinding[] {
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
