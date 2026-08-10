export interface ReviewPromptFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface PromptSourceFile {
  path: string;
  content: string;
}

export interface ReviewPromptContext {
  /** A compact system policy for bounded, diff-only reviewer shards. */
  promptProfile?: 'focused';
  /** Per-call diff budget for focused reviewers. It can only reduce the global prompt cap. */
  diffBudgetChars?: number;
  /**
   * Required reviewer shards must either receive their entire assigned diff or
   * fail before any provider call. Sampling is only permitted for explicitly
   * best-effort prompt surfaces.
   */
  diffCoverage?: 'require-complete';
  /** Repo file paths at the reviewed SHA. */
  treePaths?: string[];
  /** Files the changed code imports, for cross-file reasoning. */
  related?: PromptSourceFile[];
  /** Files that import the changed code (reverse dependencies). */
  dependents?: PromptSourceFile[];
  /** Source contents of changed files; hunks lack surrounding logic. */
  changedContents?: PromptSourceFile[];
  /** Changed files omitted before source context could be built. */
  omittedChangedContents?: string[];
  /** Remaining repository files, provided only as review context. */
  others?: PromptSourceFile[];
  /** Relevance-ranked context candidates omitted before prompt construction. */
  omittedRelated?: string[];
  omittedDependents?: string[];
  omittedOthers?: string[];
  /** Per-pass review lens. This is deliberately appended after stable context. */
  extraFocus?: string;
}

export interface SourceChunk {
  start: number;
  end: number;
  content: string;
}
