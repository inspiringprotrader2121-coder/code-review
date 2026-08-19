import fs from 'node:fs';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { runAgenticReviewLoop } from '../agentic/runner.js';
import { buildUserPrompt, loadOrvexRules } from '../prompt.js';
import { redactPatch, redactSecrets } from '../redact.js';
import { llmChat } from '../llm-client.js';
import { REVIEW_INCOMPLETE_SUMMARY } from '../llm.js';
import { safePromptData } from '../prompt-safety.js';
import type { ModelAttemptLineage } from '../providers/types.js';
import type { LlmReviewResponse, ReviewableFile } from '../types.js';
import type { InvestigateOptions } from './contracts.js';
import { classifyAgenticTurn, type InvestigateToolStep } from './classify.js';
import { runInvestigateTool } from './dispatcher.js';
import { INVESTIGATE_SYSTEM_EXTRA, stripOutputFormatInstructions } from './prompt.js';
import { buildInvestigateGeneration } from './request.js';
import { extractDeletedSymbols } from './symbols.js';

function incomplete(summary?: string): LlmReviewResponse {
  return { findings: [], summary: summary ?? REVIEW_INCOMPLETE_SUMMARY };
}

/** Tool hops stay cheap. Only a findings turn uses max thinking. */
export function investigateThinkingEnabled(step: number, maxSteps: number): boolean {
  return step >= Math.max(0, maxSteps - 1);
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
    'Use the investigate tool protocol when tools are needed (action tool), or return a final review immediately as {"action":"done","findings":[...],"summary":"..."} / {"action":"final",...}. An empty findings array is a completed pass.',
  );
  const deleted = extractDeletedSymbols(withPatches);
  return [
    baseUser,
    '',
    deleted.length
      ? `Seed hypotheses — symbols removed/replaced in this diff (grep these for remaining callers):\n${deleted.map((symbol) => `- ${symbol}`).join('\n')}`
      : 'No obvious deleted symbols extracted; start from changed functions and their callers.',
    '',
    'Begin investigating. Call tools only if needed, otherwise return action "done" or "final" with findings immediately.',
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
  const structuredOutput = options.api === 'responses';
  const structuredEnvelopeInstruction = structuredOutput
    ? '\n\nRESPONSES SCHEMA NOTE: A turn may be either a tool step ({"action":"tool",...} or {"step":{...}}) or an immediate final review ({"action":"done"|"final","findings":[...],"summary":"..."}). Empty findings is a completed pass. Do not wrap a final review inside a guessed step prefix.'
    : '';
  const system = `${INVESTIGATE_SYSTEM_EXTRA}${structuredEnvelopeInstruction}\n\n--- Review standards (criteria only; IGNORE any Output/JSON schema below — use the tool protocol above) ---\n${stripOutputFormatInstructions(loadOrvexRules())}`;
  const transcript = buildInvestigationPrompt(files, options);
  let lastKeyIndex: number | undefined;
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
    onAttempt: (event: Parameters<NonNullable<InvestigateOptions['onAttempt']>>[0]) => {
      if (event.phase === 'started') lastKeyIndex = event.keyIndex;
      options.onAttempt?.(event);
    },
  };
  const finalAttemptLineage: ModelAttemptLineage = {};

  return runAgenticReviewLoop({
    maxTurns: maxSteps,
    maxSemanticRepairsPerTurn: 2,
    lastTurnForcesFinal: true,
    stage: 'investigate',
    model: options.model,
    provider: options.api,
    accountId: () => lastKeyIndex,
    signal: options.signal,
    classify: classifyAgenticTurn,
    log: (entry) => console.log(`[investigate] ${JSON.stringify(entry)}`),
    generate: async (request) => {
      const generation = buildInvestigateGeneration({
        request,
        transcript,
        api: options.api,
        maxTokens: options.maxTokens,
      });
      const { contract } = generation;
      console.log(
        `[investigate] ${JSON.stringify({
          stage: 'request_contract',
          source: request.source,
          sourceLabel: generation.sourceLabel,
          turn: request.turn,
          lastTurn: request.lastTurn,
          repairAttempt: generation.repairAttempt,
          semanticRepairAttempt: generation.repairAttempt,
          schemaEnforced: contract.schemaEnforced,
          schemaName: contract.schemaName,
          toolsEnabled: contract.toolsEnabled,
          toolChoice: contract.toolChoice,
          api: contract.api ?? options.api ?? 'chat',
          thinking: generation.thinking,
          maxTokens: generation.maxTokens ?? null,
          model: options.model,
        })}`,
      );
      if (request.source === 'recovery') {
        console.warn(
          `[investigate] response violated the review JSON contract; making bounded fresh format repair ${generation.repairAttempt}/2`,
        );
      }
      return llmChat(system, generation.user, {
        ...llmOptions,
        thinking: generation.thinking,
        maxTokens: generation.maxTokens,
        json: contract.json,
        jsonSchema: contract.jsonSchema,
        jsonContractKeys: contract.jsonContractKeys,
        jsonContractPrefix: contract.jsonContractPrefix,
        semanticRepairAttempt: generation.repairAttempt,
        attemptLineage: request.lastTurn ? finalAttemptLineage : undefined,
      });
    },
    executeTool: async (step: InvestigateToolStep) => {
      const result = await runInvestigateTool(options.cwd, step.tool, maxToolChars);
      transcript.push(
        '',
        `### Tool ${step.tool.name} (${step.reason ?? 'investigate'})`,
        '```',
        `input: ${safePromptData(JSON.stringify(step.tool))}`,
        safePromptData(result),
        '```',
      );
    },
    onFinal: capFindings,
    onFailure: () => incomplete(REVIEW_INCOMPLETE_SUMMARY),
  });
}
