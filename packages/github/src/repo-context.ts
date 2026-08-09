import type { Octokit } from '@octokit/rest';
import { fetchRepoSnapshot, fetchRepoTree } from './repo-context/archive-snapshot.js';
import type { BuildContextOptions, RepoContext } from './repo-context/contracts.js';
import { collectRelatedPaths, findDependentPaths } from './repo-context/import-graph.js';
import { resolveContextBudgets } from './repo-context/limits.js';
import { rankContextCandidates, retrieveOtherContext } from './repo-context/relevance.js';
import {
  createSnapshotReader,
  selectChangedSources,
  selectRankedContext,
} from './repo-context/source-selection.js';

export type { BuildContextOptions, RelatedFile, RepoContext } from './repo-context/contracts.js';
export {
  fetchRepoSnapshot,
  fetchRepoTree,
  isSafeSnapshotPath,
} from './repo-context/archive-snapshot.js';
export { parseRelativeImports, resolveImportToTreePath } from './repo-context/import-graph.js';

/**
 * Full-repo review context, computed from an in-memory snapshot of the repo
 * at the reviewed sha. The public facade stays intentionally small; archive
 * retrieval, graph resolution, ranking and budget accounting live in focused
 * internal modules.
 */
export async function buildRepoContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  changedFiles: string[],
  opts: BuildContextOptions = {},
): Promise<RepoContext> {
  const budgets = resolveContextBudgets(opts);
  let snapshot: Map<string, string> | null = null;
  try {
    // Retain enough source to resolve context even for callers that later clip
    // per-file review context to a much smaller budget.
    snapshot = await fetchRepoSnapshot(octokit, owner, repo, sha, {
      maxFileBytes: Math.max(budgets.maxFileBytes, 120_000),
    });
  } catch {
    snapshot = null;
  }

  const treePaths = snapshot
    ? [...snapshot.keys()]
    : await fetchRepoTree(octokit, owner, repo, sha);
  const tree = new Set(treePaths);
  const readFile = createSnapshotReader(octokit, owner, repo, sha, snapshot, changedFiles);
  const changedSelection = await selectChangedSources(
    changedFiles,
    budgets.maxSourceFiles,
    readFile,
  );
  const relatedPaths = collectRelatedPaths(
    changedSelection.included,
    changedFiles,
    treePaths,
    tree,
  );
  const relatedSelection = await selectRankedContext(
    rankContextCandidates(snapshot, changedFiles, relatedPaths, budgets.maxFileBytes),
    budgets.maxRelated,
    budgets.maxFileBytes,
    readFile,
  );

  const includedContext = new Set(relatedSelection.included.map((file) => file.path));
  const dependentPaths = findDependentPaths(snapshot, changedFiles, includedContext, tree);
  const dependentSelection = await selectRankedContext(
    rankContextCandidates(snapshot, changedFiles, dependentPaths, budgets.maxFileBytes),
    budgets.maxDependents,
    budgets.maxFileBytes,
    readFile,
  );
  for (const file of dependentSelection.included) includedContext.add(file.path);

  const others = [];
  const omittedOthers: string[] = [];
  if (snapshot && budgets.maxOthers > 0) {
    const excluded = new Set<string>([...changedFiles, ...includedContext]);
    for (const file of retrieveOtherContext(
      snapshot,
      changedFiles,
      excluded,
      budgets.maxOthers,
      budgets.maxFileBytes,
    )) {
      if (others.length >= budgets.maxOthers) omittedOthers.push(file.path);
      else others.push({ path: file.path, content: file.content });
    }
  }

  return {
    treePaths,
    related: relatedSelection.included,
    dependents: dependentSelection.included,
    changedContents: changedSelection.included,
    omittedChangedContents: changedSelection.omitted,
    others,
    omittedRelated: relatedSelection.omitted,
    omittedDependents: dependentSelection.omitted,
    omittedOthers,
  };
}
