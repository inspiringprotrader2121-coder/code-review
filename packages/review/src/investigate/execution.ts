import fs from 'node:fs';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { buildUserPrompt, loadOrvexRules } from '../prompt.js';
import { redactPatch, redactSecrets } from '../redact.js';
import { extractJsonLoose, llmChat } from '../llm-client.js';
import { isTransientLlmError, normalizeLlmResponse, REVIEW_INCOMPLETE_SUMMARY } from '../llm.js';
import { safePromptData } from '../prompt-safety.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from '../types.js';
import type { InvestigateOptions, InvestigateStep } from './contracts.js';
import { StepSchema } from './contracts.js';
import { runInvestigateTool } from './dispatcher.js';
import { clip } from './output.js';
import { INVESTIGATE_SYSTEM_EXTRA, stripOutputFormatInstructions } from './prompt.js';
import { extractDeletedSymbols } from './symbols.js';

function incomplete(summary?: string): LlmReviewResponse {
  return { findings: [], summary: summary ?? REVIEW_INCOMPLETE_SUMMARY };
}

function parseStep(text: string): InvestigateStep | null {
  try {
    return StepSchema.parse(extractJsonLoose(text));
  } catch {
    return null;
  }
}

function capFindings(response: LlmReviewResponse): LlmReviewResponse {
  const cap = loadReviewRuntimeConfig().maxFindings;
  const rank = (severity: string): number =>
    severity === 'P1' ? 0 : severity === 'P2' ? 1 : severity === 'P3' ? 2 : 3;
  const findings = [...response.findings].sort(
    (left, right) => rank(left.severity) - rank(right.severity),
  );
  if (findings.length > cap) {
    console.warn(
      `[investigate] capping ${findings.length} findings to ${cap}; ${findings.length - cap} lowest-severity dropped`,
    );
  }
  return { ...response, findings: findings.slice(0, cap) };
}

function buildInvestigationPrompt(files: ReviewableFile[], options: InvestigateOptions): string[] {
  const withPatches = files.filter((file) => file.patch);
  const changed = withPatches.filter((file) => file.status !== 'removed');
  const reviewable = changed.length > 0 ? changed : withPatches;
  const redactedFiles = reviewable.map((file) => ({
    filename: file.filename,
    status: file.status,
    patch: redactPatch(file.patch),
  }));
  const redactAll = (items?: Array<{ path: string; content: string }>) =>
    items?.map((file) => ({ ...file, content: redactSecrets(file.content) }));
  const context = options.context
    ? {
        treePaths: options.context.treePaths,
        related: redactAll(options.context.related),
        dependents: redactAll(options.context.dependents),
        changedContents: redactAll(options.context.changedContents),
        others: redactAll(options.context.others),
        extraFocus: options.context.extraFocus,
      }
    : undefined;
  const baseUser = buildUserPrompt(redactedFiles, context).replace(
    'Return JSON: { "findings": [...], "summary": "..." }',
    'Do NOT return bare findings JSON yet. Use the investigate tool protocol (action tool|done) from the system prompt. Only action "done" carries findings/summary.',
  );
  const deleted = extractDeletedSymbols(withPatches);
  return [
    baseUser,
    '',
    deleted.length
      ? `Seed hypotheses — symbols removed/replaced in this diff (grep these for remaining callers):\n${deleted.map((symbol) => `- ${symbol}`).join('\n')}`
      : 'No obvious deleted symbols extracted; start from changed functions and their callers.',
    '',
    'Begin investigating. Call tools as needed, then return action "done" with findings.',
  ];
}

/** Run a sandboxed investigate review: iterative tool use, then final findings. */
export async function runInvestigateReview(
  files: ReviewableFile[],
  options: InvestigateOptions,
): Promise<LlmReviewResponse> {
  const reviewable = files.filter((file) => file.patch && file.status !== 'removed');
  if ((reviewable.length || files.filter((file) => file.patch).length) === 0) {
    return {
      findings: [],
      summary:
        'No reviewable text diff in this PR (binary, lockfiles, or generated paths skipped).',
    };
  }
  if (!options.cwd || !fs.existsSync(options.cwd))
    throw new Error('investigate requires a repo checkout (cwd)');
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('investigate cancelled');

  const maxSteps = options.maxSteps ?? loadReviewRuntimeConfig().investigateMaxSteps;
  const maxToolChars = options.maxToolOutputChars ?? loadReviewRuntimeConfig().investigateToolChars;
  const system = `${INVESTIGATE_SYSTEM_EXTRA}\n\n--- Review standards (criteria only; IGNORE any Output/JSON schema below — use the tool protocol above) ---\n${stripOutputFormatInstructions(loadOrvexRules())}`;
  const transcript = buildInvestigationPrompt(files, options);
  const llmOptions = {
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    api: options.api,
    reasoningEffort: options.reasoningEffort,
    maxTokens: options.maxTokens,
    signal: options.signal,
    json: true as const,
    onUsage: options.onUsage,
    onAttempt: options.onAttempt,
  };

  for (let step = 0; step < maxSteps; step++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('investigate cancelled');
    const forceDone = step === maxSteps - 1;
    const user = forceDone
      ? `${transcript.join('\n')}\n\nFINAL TURN — you MUST respond with {"action":"done",...} now. No more tools.`
      : transcript.join('\n');
    let text: string;
    try {
      text = await llmChat(system, user, llmOptions);
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (step === 0 || isTransientLlmError(message)) throw error;
      console.warn(`[investigate] llm error on step ${step}: ${message.slice(0, 160)}`);
      return incomplete(REVIEW_INCOMPLETE_SUMMARY);
    }

    const parsed = parseStep(text);
    if (!parsed) {
      try {
        const review = LlmReviewResponseSchema.parse(normalizeLlmResponse(extractJsonLoose(text)));
        if (review.findings.length > 0) return capFindings(review);
      } catch {
        // The tool-loop protocol remains authoritative for malformed responses.
      }
      if (forceDone) return incomplete(REVIEW_INCOMPLETE_SUMMARY);
      transcript.push(
        '',
        '### Model reply (unparseable)',
        safePromptData(clip(text, 4_000)),
        '',
        'Respond with valid JSON (action tool|done).',
      );
      continue;
    }

    if (parsed.action === 'done') {
      try {
        const rawCount = Array.isArray(parsed.findings) ? parsed.findings.length : 0;
        const review = LlmReviewResponseSchema.parse(
          normalizeLlmResponse({ findings: parsed.findings ?? [], summary: parsed.summary }),
        );
        return rawCount > 0 && review.findings.length === 0
          ? incomplete(REVIEW_INCOMPLETE_SUMMARY)
          : capFindings(review);
      } catch {
        return incomplete(REVIEW_INCOMPLETE_SUMMARY);
      }
    }

    if (forceDone) return incomplete(REVIEW_INCOMPLETE_SUMMARY);
    const result = await runInvestigateTool(options.cwd, parsed.tool, maxToolChars);
    transcript.push(
      '',
      `### Tool ${parsed.tool.name} (${parsed.reason ?? 'investigate'})`,
      '```',
      `input: ${safePromptData(JSON.stringify(parsed.tool))}`,
      safePromptData(result),
      '```',
    );
  }

  return incomplete(REVIEW_INCOMPLETE_SUMMARY);
}
