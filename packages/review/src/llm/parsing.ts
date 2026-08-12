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
export function jsonFinishPrefix(text: string): string {
  const stripped = stripThinking(text);
  const start = stripped.indexOf('{');
  if (start === -1) return '{"findings":';
  const slice = stripped.slice(start);
  if (tryParse(slice) !== undefined) return '{"findings":';
  return slice || '{"findings":';
}

export function jsonContractMissing(text: string): boolean {
  try {
    extractJsonLoose(text);
    return false;
  } catch {
    return true;
  }
}
