export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

export function extractJsonLoose(text: string): unknown {
  const stripped = stripThinking(text);
  const jsonFence = stripped.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    const parsed = tryParse(jsonFence[1]);
    if (parsed !== undefined) return parsed;
  }
  for (const match of stripped.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)) {
    const parsed = tryParse(match[1]);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(stripped.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }
  const bare = tryParse(stripped);
  if (bare !== undefined) return bare;
  throw new Error('LLM response contained no parseable JSON');
}

/**
 * Prefix used only to finish truncated JSON. Complete parseable objects return
 * null so callers must not seed a guessed contract fragment onto a finished reply.
 * An omitted/empty contractPrefix disables guessed seeds such as `{"step":{"action":`.
 */
export function jsonFinishPrefix(text: string, contractPrefix = '{"findings":'): string | null {
  const stripped = stripThinking(text);
  const start = stripped.indexOf('{');
  if (start === -1) return contractPrefix || null;
  const slice = stripped.slice(start);
  if (tryParse(slice) !== undefined) return null;
  return slice || contractPrefix || null;
}

export type JsonContractKey = 'findings' | 'issues' | 'verdicts' | 'action' | 'clusters' | 'step';

const DEFAULT_JSON_CONTRACT_KEYS: readonly JsonContractKey[] = ['findings', 'issues', 'verdicts'];

function hasJsonContractKey(root: Record<string, unknown>, key: JsonContractKey): boolean {
  if (key === 'action') return typeof root.action === 'string' && root.action.trim().length > 0;
  if (key === 'step') return Boolean(root.step && typeof root.step === 'object');
  return Array.isArray(root[key]);
}

export function jsonContractMissing(
  text: string,
  acceptedKeys: readonly JsonContractKey[] = DEFAULT_JSON_CONTRACT_KEYS,
): boolean {
  try {
    const parsed = extractJsonLoose(text);
    if (Array.isArray(parsed)) return false;
    if (!parsed || typeof parsed !== 'object') return true;
    const root = parsed as Record<string, unknown>;
    return !acceptedKeys.some((key) => hasJsonContractKey(root, key));
  } catch {
    return true;
  }
}

export type StructuredFailureClass =
  | 'valid_final'
  | 'empty'
  | 'complete_non_json'
  | 'complete_invalid_json'
  | 'schema_mismatch'
  | 'truncated_json';

export type StructuredRecoveryMode = 'none' | 'continuation' | 'fresh_semantic_repair';

export interface StructuredOutputClassification {
  parseResult: 'ok' | 'empty' | 'invalid' | 'schema_mismatch';
  failureClass: StructuredFailureClass;
  recoveryMode: StructuredRecoveryMode;
}

const TRUNCATION_STOP_REASONS = new Set([
  'max_tokens',
  'length',
  'max_output_tokens',
  'incomplete',
]);

/** Provider stop/finish reasons that are positive evidence of truncated generation. */
export function isTruncationStopReason(stopReason?: string | null): boolean {
  if (!stopReason) return false;
  const normalized = stopReason.trim().toLowerCase();
  if (TRUNCATION_STOP_REASONS.has(normalized)) return true;
  return /max[_-]?tokens|max[_-]?output/.test(normalized);
}

/**
 * Decide whether a JSON-contract miss is truncated generation (continuation)
 * or a completed wrong answer (fresh semantic repair).
 *
 * `JSON.parse` failing is not truncation. Continuation requires a truncation
 * stop reason plus incomplete JSON. `end_turn` / `stop` / `completed` are
 * finished answers even when the text looks like open JSON.
 */
export function classifyStructuredOutput(
  text: string,
  acceptedKeys: readonly JsonContractKey[] = DEFAULT_JSON_CONTRACT_KEYS,
  stopReason?: string | null,
): StructuredOutputClassification {
  const truncated = isTruncationStopReason(stopReason);
  if (!text.trim()) {
    return {
      parseResult: 'empty',
      failureClass: 'empty',
      recoveryMode: truncated ? 'continuation' : 'fresh_semantic_repair',
    };
  }
  if (!jsonContractMissing(text, acceptedKeys)) {
    return { parseResult: 'ok', failureClass: 'valid_final', recoveryMode: 'none' };
  }
  try {
    extractJsonLoose(text);
    return {
      parseResult: 'schema_mismatch',
      failureClass: 'schema_mismatch',
      recoveryMode: 'fresh_semantic_repair',
    };
  } catch {
    if (truncated) {
      return {
        parseResult: 'invalid',
        failureClass: 'truncated_json',
        recoveryMode: 'continuation',
      };
    }
    const hasObjectStart = stripThinking(text).includes('{');
    return {
      parseResult: 'invalid',
      failureClass: hasObjectStart ? 'complete_invalid_json' : 'complete_non_json',
      recoveryMode: 'fresh_semantic_repair',
    };
  }
}

export class JsonContractMismatchError extends Error {
  readonly text: string;
  readonly failureClass: StructuredFailureClass;
  readonly recoveryMode: StructuredRecoveryMode;
  readonly parseResult: StructuredOutputClassification['parseResult'];
  readonly stopReason?: string | null;
  constructor(
    text: string,
    meta: Partial<StructuredOutputClassification> & { stopReason?: string | null } = {},
  ) {
    super('LLM response JSON contract mismatch');
    this.name = 'JsonContractMismatchError';
    this.text = text;
    const classified = classifyStructuredOutput(text, DEFAULT_JSON_CONTRACT_KEYS, meta.stopReason);
    this.failureClass = meta.failureClass ?? classified.failureClass;
    this.recoveryMode = meta.recoveryMode ?? classified.recoveryMode;
    this.parseResult = meta.parseResult ?? classified.parseResult;
    this.stopReason = meta.stopReason;
  }
}
