export interface RelatedFile {
  path: string;
  content: string;
}

export interface RepoContext {
  /** repo file paths at the reviewed sha (capped) */
  treePaths: string[];
  /** contents of files the changed code imports — cross-file review context */
  related: RelatedFile[];
  /** files that import the changed code (reverse dependencies) */
  dependents: RelatedFile[];
  /** full contents of the changed files themselves (diff hunks lack surrounding logic) */
  changedContents: RelatedFile[];
  /** changed files whose source context was not retrieved under the source cap */
  omittedChangedContents: string[];
  /** every remaining code file in the repo snapshot — true full-repo context */
  others: RelatedFile[];
  /** relevance-ranked candidates that did not fit the retrieval cap */
  omittedRelated: string[];
  /** relevance-ranked reverse dependencies that did not fit the retrieval cap */
  omittedDependents: string[];
  /** relevance-ranked repository files that did not fit the retrieval cap */
  omittedOthers: string[];
}

export interface BuildContextOptions {
  /** max imported files included (default 8) */
  maxRelated?: number;
  /** max reverse-dependency files included (default 8) */
  maxDependents?: number;
  /** max bytes kept per context file (default 16 kB) */
  maxFileBytes?: number;
  /** max changed files whose imports are chased (default 10) */
  maxSourceFiles?: number;
  /** max remaining repo code files included in full (default 0 = off) */
  maxOthers?: number;
}

export interface ContextBudgets {
  maxRelated: number;
  maxDependents: number;
  maxFileBytes: number;
  maxSourceFiles: number;
  maxOthers: number;
}
