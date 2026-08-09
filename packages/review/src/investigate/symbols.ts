import type { ReviewableFile } from '../types.js';

/** Pull likely deleted/renamed identifiers from unified diffs to seed grep. */
export function extractDeletedSymbols(files: ReviewableFile[], limit = 24): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /^\-\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w$]*)/,
    /^\-\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w$]*)\s*=/,
    /^\-\s*(?:export\s+)?class\s+([A-Za-z_][\w$]*)/,
    /^\-\s*(?:export\s+)?(?:async\s+)?([A-Za-z_][\w$]*)\s*\([^)]*\)\s*\{/,
    /^\-\s*([A-Za-z_][\w$]*)\s*\([^)]*\)\s*\{/,
  ];

  for (const file of files) {
    if (!file.patch) continue;
    for (const line of file.patch.split('\n')) {
      if (!line.startsWith('-') || line.startsWith('---')) continue;
      for (const pattern of patterns) {
        const match = pattern.exec(line);
        const name = match?.[1];
        if (!name || name.length < 2 || seen.has(name)) continue;
        if (/^(if|for|while|switch|return|throw|await|import|from|type|interface)$/.test(name))
          continue;
        seen.add(name);
        symbols.push(name);
        if (symbols.length >= limit) return symbols;
      }
    }
  }

  return symbols;
}
