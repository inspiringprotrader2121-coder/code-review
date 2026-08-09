import { fetchFileContent, type createInstallationOctokit } from '@orvex-review/github';
import {
  checkImportBindings,
  collapseSameDefect,
  aggregateRepeatedFindings,
  dedupeByFileLine,
  dropSelfNegatingFindings,
  filterAndCapFindings,
  fingerprintFinding,
  mergeFindings,
  partitionVerifiedFindings,
  type ReviewFinding,
  type ReviewSurfaceFinding,
  type RepeatedFinding,
  type RepeatedFindingAggregation,
  type VerificationDisposition,
  type VerifiedFindings,
} from '@orvex-review/review';
import {
  auditFindingsFromContent,
  runSemgrepOnPaths,
  shouldIgnorePath,
  type ReviewConfig,
} from '@orvex-review/rules';
import type { StoredFinding } from '@orvex-review/store';

type LineIndexEntry = { added: Set<number>; context: Set<number> };
type AddedLineMap = Map<string, LineIndexEntry>;

export interface FindingPipelineInput {
  files: Array<{ filename: string; patch?: string }>;
  reviewConfig: ReviewConfig;
  priorFindings: StoredFinding[];
  verifiedFixed: StoredFinding[];
  toPost: ReviewFinding[];
  reviewOnly: ReviewSurfaceFinding[];
  newlyFixed: StoredFinding[];
  stillOpen: StoredFinding[];
  maxInlinePerPr: number;
}

export interface FindingPipelineResult {
  toPost: ReviewFinding[];
  reviewOnly: ReviewSurfaceFinding[];
  allFixed: StoredFinding[];
  inline: ReviewFinding[];
  summaryOnly: ReviewFinding[];
  nitpicks: ReviewFinding[];
  stats: { newCount: number; fixedCount: number; openCount: number };
}

/** Pure finding normalization after model computation and before publication. */
export class FindingPipeline {
  aggregateRepeated(
    entries: RepeatedFinding[],
    options: Parameters<typeof aggregateRepeatedFindings>[1],
  ): Promise<RepeatedFindingAggregation> {
    return aggregateRepeatedFindings(entries, options);
  }

  mergeAndFilter(input: {
    incoming: ReviewFinding[];
    priorOpen: StoredFinding[];
    headSha: string;
    manualCandidates: ReviewSurfaceFinding[];
    reviewedFiles: Set<string>;
    priorReviewSha?: string;
    protectedFingerprints: Set<string>;
    suppressedFingerprints: Set<string>;
  }): ReturnType<typeof mergeFindings> {
    const merged = mergeFindings(dedupeByFileLine(input.incoming), input.priorOpen, input.headSha, {
      manualCandidates: input.manualCandidates,
      reviewedFiles: input.reviewedFiles,
      priorReviewSha: input.priorReviewSha,
      protectedFingerprints: input.protectedFingerprints,
    });
    if (input.suppressedFingerprints.size > 0) {
      merged.toPost = merged.toPost.filter(
        (finding) => !input.suppressedFingerprints.has(fingerprintFinding(finding)),
      );
      merged.reviewOnly = merged.reviewOnly.filter(
        ({ finding }) => !input.suppressedFingerprints.has(fingerprintFinding(finding)),
      );
    }
    const normal = dropSelfNegatingFindings(merged.toPost);
    if (normal.dropped.length > 0) {
      console.log(
        `[worker] noise filter dropped ${normal.dropped.length}: ` +
          normal.dropped.map((finding) => `${finding.severity} ${finding.file}`).join(', '),
      );
    }
    merged.toPost = normal.kept;
    const manual = dropSelfNegatingFindings(merged.reviewOnly.map(({ finding }) => finding));
    if (manual.dropped.length > 0) {
      console.log(
        `[worker] noise filter removed ${manual.dropped.length} manual-review candidate(s): ` +
          manual.dropped.map((finding) => `${finding.severity} ${finding.file}`).join(', '),
      );
    }
    const manualKept = new Set(manual.kept.map((finding) => fingerprintFinding(finding)));
    merged.reviewOnly = merged.reviewOnly.filter(({ finding }) =>
      manualKept.has(fingerprintFinding(finding)),
    );
    return merged;
  }

  async buildVerificationFiles(input: {
    contextFiles: Array<{ path: string; content: string }>;
    changedFiles: Array<{ filename: string; patch?: string }>;
    treePaths: string[];
    deepVerify: boolean;
    readFile: (path: string) => Promise<string | null>;
  }): Promise<Array<{ path: string; content: string }>> {
    const verifyFiles = [...input.contextFiles];
    const haveContent = new Set(verifyFiles.map((file) => file.path));
    for (const file of input.changedFiles) {
      if (!haveContent.has(file.filename) && file.patch) {
        verifyFiles.push({
          path: file.filename,
          content: `Diff (changed lines) for this file:\n${file.patch}`,
        });
        haveContent.add(file.filename);
      }
    }
    if (!input.deepVerify) return verifyFiles;
    const manifests = new Set([
      'package.json',
      'pnpm-workspace.yaml',
      'requirements.txt',
      'pyproject.toml',
      'go.mod',
      'composer.json',
      'Gemfile',
      'Cargo.toml',
      'pom.xml',
      'build.gradle',
    ]);
    const changed = input.changedFiles
      .map((file) => file.filename)
      .filter((filePath) => manifests.has(filePath.split('/').pop() ?? ''));
    const fromTree = input.treePaths
      .filter(
        (filePath) =>
          manifests.has(filePath.split('/').pop() ?? '') && filePath.split('/').length <= 3,
      )
      .slice(0, 6);
    for (const filePath of new Set([...changed, ...fromTree])) {
      if (haveContent.has(filePath)) continue;
      try {
        const content = await input.readFile(filePath);
        if (content) {
          verifyFiles.push({ path: filePath, content: content.slice(0, 20_000) });
          haveContent.add(filePath);
        }
      } catch {
        // Optional manifest evidence must not fail the precision gate.
      }
    }
    return verifyFiles;
  }

  applyVerification(input: {
    toPost: ReviewFinding[];
    reviewOnly: ReviewSurfaceFinding[];
    verified: VerifiedFindings;
    verifierTier: string;
  }): VerificationDisposition {
    return partitionVerifiedFindings(input.toPost, input.reviewOnly, input.verified, {
      verifierTier: input.verifierTier,
    });
  }

  prepare(input: FindingPipelineInput): FindingPipelineResult {
    const addedLinesByFile = buildAddedLineIndex(input.files);
    let toPost = input.toPost.map((finding) => normalizeFindingLine(finding, addedLinesByFile));
    toPost = dedupeByFileLine(toPost);
    toPost = collapseSameDefect(toPost);
    const reviewOnly = input.reviewOnly.map((item) => ({
      ...item,
      finding: normalizeFindingLine(item.finding, addedLinesByFile),
    }));
    const allFixed = dedupeByFingerprint([...input.verifiedFixed, ...input.newlyFixed]);
    let { inline, summaryOnly, nitpicks } = filterAndCapFindings(toPost, input.reviewConfig);
    const priorInline = input.priorFindings.filter((finding) => finding.githubCommentId).length;
    const inlineBudget = Math.max(0, input.maxInlinePerPr - priorInline);
    if (inline.length > inlineBudget) {
      summaryOnly = [...summaryOnly, ...inline.slice(inlineBudget)];
      inline = inline.slice(0, inlineBudget);
    }
    return {
      toPost,
      reviewOnly,
      allFixed,
      inline,
      summaryOnly,
      nitpicks,
      stats: {
        newCount: toPost.length,
        fixedCount: allFixed.length,
        openCount: input.stillOpen.length + toPost.length,
      },
    };
  }
}

function dedupeByFingerprint(findings: StoredFinding[]): StoredFinding[] {
  const byFingerprint = new Map<string, StoredFinding>();
  for (const finding of findings) byFingerprint.set(finding.fingerprint, finding);
  return [...byFingerprint.values()];
}

function buildAddedLineIndex(files: Array<{ filename: string; patch?: string }>): AddedLineMap {
  const map: AddedLineMap = new Map();
  for (const file of files) {
    if (!file.patch) continue;
    const index = parseAddedLinesFromPatch(file.patch);
    if (index.added.size > 0 || index.context.size > 0) map.set(file.filename, index);
  }
  return map;
}

function parseAddedLinesFromPatch(patch: string): LineIndexEntry {
  const added = new Set<number>();
  const context = new Set<number>();
  let newLine = 0;
  let hunkAdded = new Set<number>();
  let hunkContext: number[] = [];
  const flushHunk = () => {
    if (hunkAdded.size === 0) for (const line of hunkContext) context.add(line);
    hunkAdded = new Set();
    hunkContext = [];
  };
  const lines = patch.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index]!;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('\\')) continue;
    if (line === '' && index === lines.length - 1) continue;
    const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (match) {
      flushHunk();
      newLine = Number(match[1]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (newLine > 0) {
        added.add(newLine);
        hunkAdded.add(newLine);
      }
      newLine += 1;
    } else if (!line.startsWith('-') && newLine > 0) {
      hunkContext.push(newLine);
      newLine += 1;
    }
  }
  flushHunk();
  return { added, context };
}

function normalizeFindingLine(finding: ReviewFinding, index: AddedLineMap): ReviewFinding {
  const fileIndex = index.get(finding.file);
  if (!fileIndex || (fileIndex.added.size === 0 && fileIndex.context.size === 0)) {
    return { ...finding, line: undefined };
  }
  if (finding.line && fileIndex.added.has(finding.line)) {
    return { ...finding, lineRelocated: false, anchorContext: false };
  }
  if (fileIndex.added.size > 0) {
    return {
      ...finding,
      line: nearestLine(fileIndex.added, finding.line),
      lineRelocated: true,
      anchorContext: false,
    };
  }
  if (finding.line && fileIndex.context.has(finding.line)) {
    return { ...finding, lineRelocated: false, anchorContext: true };
  }
  return {
    ...finding,
    line: nearestLine(fileIndex.context, finding.line),
    lineRelocated: true,
    anchorContext: true,
  };
}

function nearestLine(lines: Set<number>, requested?: number): number {
  let bestLine = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (requested === undefined) {
      if (line < bestLine) bestLine = line;
    } else {
      const distance = Math.abs(line - requested);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = line;
        if (distance === 0) break;
      }
    }
  }
  return Number.isFinite(bestLine) ? bestLine : (requested ?? 1);
}

export { fingerprintFinding };

export async function runDeterministicRules(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  headSha: string,
  files: Array<{ filename: string; status: string }>,
  config: ReviewConfig,
): Promise<ReviewFinding[]> {
  const findings: ReviewFinding[] = [];

  for (const file of files) {
    if (shouldIgnorePath(file.filename, config)) continue;

    if (file.filename.endsWith('.md')) {
      const content = await fetchFileContent(octokit, owner, repo, file.filename, headSha);
      if (content) {
        findings.push(
          ...auditFindingsFromContent(content, file.filename).map((f) => ({
            ...f,
            severity: f.severity as ReviewFinding['severity'],
          })),
        );
      }
    }
  }

  if (config.run_semgrep) {
    const paths = files
      .map((f) => f.filename)
      .filter((p) => !shouldIgnorePath(p, config) && /\.(js|ts|jsx|tsx|py|go)$/.test(p));
    const semgrep = await runSemgrepOnPaths(paths);
    findings.push(
      ...semgrep.map((f) => ({
        ...f,
        severity: f.severity as ReviewFinding['severity'],
      })),
    );
  }

  // Deterministic import/export check: `const { x } = require('./m')` where
  // ./m never exports x is a guaranteed TypeError on first call. PR93's
  // getFileFromR2 bug (whole PITR feature dead) slipped past all 5 LLM passes —
  // a mechanical class gets a mechanical check. Best-effort: any fetch error
  // just skips the check; it must never fail a review.
  try {
    const jsChanged = files.filter(
      (f) =>
        f.status !== 'removed' &&
        /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(f.filename) &&
        !shouldIgnorePath(f.filename, config),
    );
    if (jsChanged.length > 0) {
      const cache = new Map<string, string | null>();
      const fetchCached = async (path: string): Promise<string | null> => {
        if (cache.has(path)) return cache.get(path) ?? null;
        let content: string | null = null;
        try {
          content = await fetchFileContent(octokit, owner, repo, path, headSha);
        } catch {
          content = null;
        }
        cache.set(path, content);
        return content;
      };
      const changedSources: Array<{ path: string; content: string }> = [];
      for (const f of jsChanged.slice(0, 60)) {
        const content = await fetchCached(f.filename);
        if (content) changedSources.push({ path: f.filename, content });
      }
      const importFindings = await checkImportBindings(changedSources, fetchCached);
      if (importFindings.length > 0) {
        console.log(
          `[worker] import check: ${importFindings.length} unresolved named import(s): ` +
            importFindings.map((f) => `${f.file}:${f.line}`).join(', '),
        );
      }
      findings.push(...importFindings);
    }
  } catch (err) {
    console.warn('[worker] import check skipped:', (err as Error).message);
  }

  return findings;
}
