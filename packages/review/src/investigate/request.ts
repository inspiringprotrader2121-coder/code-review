import type { AgenticGenerateRequest, AgenticSourceLabel } from '../agentic/types.js';
import { wrapAgenticRecoveryUser } from '../agentic/recovery.js';
import type { JsonContractKey } from '../llm-client.js';
import { safePromptData } from '../prompt-safety.js';
import type { InvestigateOptions } from './contracts.js';
import { InvestigateFinalJsonSchema, InvestigateStepJsonSchema } from './contracts.js';
import { clip } from './output.js';

export const INVESTIGATE_CONTRACT_KEYS: readonly JsonContractKey[] = [
  'step',
  'action',
  'findings',
  'issues',
];

export type InvestigateToolChoice = 'tool_or_final' | 'final_only';

/** Responses-API structured output for the investigate protocol — not a provider state machine. */
export function investigateJsonSchema(
  api: InvestigateOptions['api'],
  lastTurn: boolean,
): { name: string; schema: Record<string, unknown> } | undefined {
  if (api !== 'responses') return undefined;
  return lastTurn
    ? { name: 'orvex_investigate_final', schema: InvestigateFinalJsonSchema }
    : { name: 'orvex_investigate_turn', schema: InvestigateStepJsonSchema };
}

export function investigateSourceLabel(
  source: AgenticGenerateRequest['source'],
  repairAttempt = 0,
): AgenticSourceLabel {
  if (source !== 'recovery') return 'normal';
  return repairAttempt >= 2 ? 'repair_2' : 'repair_1';
}

export interface InvestigateOutputContract {
  api: InvestigateOptions['api'];
  json: true;
  jsonContractKeys: readonly JsonContractKey[];
  jsonContractPrefix: '';
  jsonSchema: { name: string; schema: Record<string, unknown> } | undefined;
  schemaEnforced: boolean;
  schemaName: string | null;
  toolsEnabled: boolean;
  toolChoice: InvestigateToolChoice;
}

/**
 * Authoritative investigate output contract. Normal and semantic-repair
 * generations share this; only the user instruction differs.
 */
export function investigateOutputContract(
  api: InvestigateOptions['api'],
  lastTurn: boolean,
): InvestigateOutputContract {
  const jsonSchema = investigateJsonSchema(api, lastTurn);
  return {
    api,
    json: true,
    jsonContractKeys: INVESTIGATE_CONTRACT_KEYS,
    jsonContractPrefix: '',
    jsonSchema,
    schemaEnforced: Boolean(jsonSchema),
    schemaName: jsonSchema?.name ?? null,
    toolsEnabled: !lastTurn,
    toolChoice: lastTurn ? 'final_only' : 'tool_or_final',
  };
}

export interface InvestigateGeneration {
  user: string;
  thinking: boolean;
  maxTokens: number | undefined;
  contract: InvestigateOutputContract;
  sourceLabel: AgenticSourceLabel;
  repairAttempt: number;
}

export function buildInvestigateGeneration(input: {
  request: AgenticGenerateRequest;
  transcript: string[];
  api: InvestigateOptions['api'];
  maxTokens?: number;
}): InvestigateGeneration {
  const { request, transcript, api, maxTokens } = input;
  const repairAttempt = request.source === 'recovery' ? Math.max(1, request.repairAttempt ?? 1) : 0;
  const contract = investigateOutputContract(api, request.lastTurn);
  const baseUser = request.lastTurn
    ? `${transcript.join('\n')}\n\nFINAL TURN — you MUST respond with {"action":"done",...} or {"action":"final",...} now. No more tools. Empty findings is a completed pass.`
    : transcript.join('\n');
  const previousClip = repairAttempt >= 2 ? 500 : 4_000;
  const user =
    request.source === 'recovery'
      ? wrapAgenticRecoveryUser(
          baseUser,
          request.lastTurn,
          request.previousText,
          (text) => safePromptData(clip(text, previousClip)),
          request.previousKind ?? 'malformed',
          repairAttempt,
        )
      : baseUser;
  return {
    user,
    thinking: request.thinking,
    maxTokens,
    contract,
    sourceLabel: investigateSourceLabel(request.source, repairAttempt),
    repairAttempt,
  };
}
