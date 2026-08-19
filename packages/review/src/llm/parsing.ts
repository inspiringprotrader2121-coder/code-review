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

/** Assistant prefix used to finish a truncated or prose-only JSON contract. */
export function jsonFinishPrefix(text: string, contractPrefix = '{"findings":'): string {
  const stripped = stripThinking(text);
  const start = stripped.indexOf('{');
  if (start === -1) return contractPrefix;
  const slice = stripped.slice(start);
  if (tryParse(slice) !== undefined) return contractPrefix;
  return slice || contractPrefix;
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
