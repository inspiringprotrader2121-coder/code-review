import { retrieveRelevantFiles } from '../repo-index.js';

/** Rank known context candidates without silently dropping zero-overlap files. */
export function rankContextCandidates(
  snapshot: Map<string, string> | null,
  changedFiles: readonly string[],
  paths: readonly string[],
  maxFileBytes: number,
): string[] {
  if (!snapshot || paths.length === 0) return [...paths].sort();
  const ranked = retrieveRelevantFiles(snapshot, [...changedFiles], {
    k: paths.length,
    maxFileBytes,
    candidatePaths: new Set(paths),
  }).map((entry) => entry.path);
  const rankedSet = new Set(ranked);
  return [...ranked, ...paths.filter((candidate) => !rankedSet.has(candidate)).sort()];
}

export function retrieveOtherContext(
  snapshot: Map<string, string>,
  changedFiles: readonly string[],
  excluded: ReadonlySet<string>,
  maxOthers: number,
  maxFileBytes: number,
) {
  return retrieveRelevantFiles(snapshot, [...changedFiles], {
    k: Math.min(1_000, maxOthers + 128),
    maxFileBytes,
    exclude: new Set(excluded),
  });
}
