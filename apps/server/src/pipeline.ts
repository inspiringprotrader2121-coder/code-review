import {
  buildRepoContext,
  createInstallationOctokit,
  createCheckRun,
  fetchFileContent,
  fetchPrDiff,
  fetchPrLabels,
  fetchPullRequest,
  fetchRepoFile,
  hasIgnoreLabel,
  isRepoAllowed,
  loadGitHubConfigFromEnv,
  postPullRequestReview,
  replyToReviewComment,
  shouldSkipPr,
  type GitHubAppConfig,
  type InlineReviewComment,
} from '@orvex-review/github';
import type { ReviewJobPayload } from '@orvex-review/queue';
import {
  auditFindingsFromContent,
  parseReviewConfigYaml,
  runSemgrepOnPaths,
  shouldIgnorePath,
  type ReviewConfig,
} from '@orvex-review/rules';
import {
  commandTrigger,
  dedupeByFileLine,
  filterAndCapFindings,
  fingerprintFinding,
  formatFixedReply,
  formatInlineFinding,
  formatReviewBody,
  llmFindingsToReviewFindings,
  mergeFindings,
  reconcileFixedOnHead,
  runLlmReview,
  toStoredFinding,
  type ReviewFinding,
} from '@orvex-review/review';
import {
  createAppDatabase,
  type AppDatabase,
  type PrReviewState,
  type StoredFinding,
} from '@orvex-review/store';

export interface WorkerConfig {
  github: GitHubAppConfig;
  llmApiKey: string;
  /** set for OpenAI-compatible providers (MiniMax); unset means Anthropic */
  llmBaseUrl?: string;
  llmModel: string;
  maxFileBytes: number;
  maxFiles: number;
  enableCheckRuns: boolean;
  store: AppDatabase;
}

let sharedStore: AppDatabase | null = null;

export function loadWorkerConfig(): WorkerConfig {
  const github = loadGitHubConfigFromEnv();

  // MiniMax (OpenAI-compatible) takes precedence when configured; Anthropic otherwise.
  const minimaxKey = process.env.MINIMAX_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!minimaxKey && !anthropicKey) {
    throw new Error('MINIMAX_API_KEY or ANTHROPIC_API_KEY is required');
  }

  if (!sharedStore) {
    sharedStore = createAppDatabase();
  }

  return {
    github,
    llmApiKey: (minimaxKey ?? anthropicKey)!,
    llmBaseUrl: minimaxKey ? (process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1') : undefined,
    llmModel: minimaxKey
      ? (process.env.MINIMAX_MODEL ?? 'MiniMax-M3')
      : (process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514'),
    maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 120_000),
    maxFiles: Number(process.env.MAX_FILES ?? 40),
    enableCheckRuns: process.env.CHECK_RUNS_ENABLED === '1',
    store: sharedStore,
  };
}

export interface ProcessResult {
  findingCount: number;
  newCount: number;
  fixedCount: number;
  reviewId?: number;
  skipReason?: string;
}

export async function processReviewJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const runBase = {
    tenantId: job.tenantId,
    installationId: job.installationId,
    owner: job.owner,
    repo: job.repo,
    pr: job.pr,
    headSha: job.headSha,
    action: job.action,
  };

  try {
    const result = await executeReview(job, config);
    config.store.recordReviewRun({
      ...runBase,
      status: result.skipReason ? 'skipped' : 'completed',
      skipReason: result.skipReason,
      durationMs: Date.now() - startedAt,
      findingsNew: result.newCount,
      findingsFixed: result.fixedCount,
      findingsOpen: result.findingCount,
    });
    return result;
  } catch (err) {
    config.store.recordReviewRun({
      ...runBase,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

async function executeReview(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const { installationId, tenantId, owner, repo, pr: number, action } = job;
  const ref = { owner, repo, number };

  if (config.github.allowedRepo && !isRepoAllowed(owner, repo, config.github.allowedRepo)) {
    throw new Error(`Repo ${owner}/${repo} not in GITHUB_ALLOWED_REPO allowlist`);
  }

  const installation = config.store.getInstallation(installationId);
  if (!installation || installation.suspendedAt) {
    throw new Error(`Installation ${installationId} not active`);
  }

  console.log(`[worker] tenant=${tenantId.slice(0, 8)} inst=${installationId} account=${installation.accountLogin}`);

  const octokit = createInstallationOctokit(config.github, installationId);

  const pr = await fetchPullRequest(octokit, ref);
  const effectiveSha = pr.headSha;

  const labels = await fetchPrLabels(octokit, ref);
  const repoConfigYaml =
    (await fetchRepoFile(octokit, owner, repo, '.orvex-review.yml', effectiveSha)) ??
    // deprecated pre-rename config filename; remove after customers migrate
    (await fetchRepoFile(octokit, owner, repo, '.velatrix-review.yml', effectiveSha));
  const reviewConfig = parseReviewConfigYaml(repoConfigYaml);

  if (hasIgnoreLabel(labels, reviewConfig.ignore_labels)) {
    console.log(`[worker] skip PR #${number}: label ${reviewConfig.ignore_labels.join('/')}`);
    return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'ignore_label' };
  }

  const skipReason = shouldSkipPr(pr, { botLogin: config.github.botLogin });
  if (skipReason) {
    console.log(`[worker] skip PR #${number}: ${skipReason}`);
    return { findingCount: 0, newCount: 0, fixedCount: 0, skipReason };
  }

  const priorState = config.store.getState({ installationId, owner, repo, pr: number });
  const sinceSha =
    action === 'synchronize' && priorState?.lastSha ? priorState.lastSha : undefined;

  const files = await fetchPrDiff(octokit, ref, {
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles,
    ignoreGlobs: reviewConfig.ignore,
    sinceSha,
    headSha: effectiveSha,
  });

  console.log(
    `[worker] PR #${number} @ ${effectiveSha.slice(0, 7)} action=${action} files=${files.length}` +
      (sinceSha ? ` incremental ${sinceSha.slice(0, 7)}..${effectiveSha.slice(0, 7)}` : ' full diff'),
  );

  const fileReader = {
    readFile: (path: string, ref: string) =>
      fetchFileContent(octokit, owner, repo, path, ref),
  };

  const priorOpen = (priorState?.findings ?? []).filter((f) => f.status === 'open');
  const { stillOpen: verifiedOpen, newlyFixed: verifiedFixed } = await reconcileFixedOnHead(
    priorOpen,
    effectiveSha,
    fileReader,
  );

  for (const fixed of verifiedFixed) {
    if (fixed.githubCommentId) {
      try {
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          number,
          fixed.githubCommentId,
          formatFixedReply(effectiveSha),
        );
      } catch (err) {
        console.warn(`[worker] could not reply on comment ${fixed.githubCommentId}:`, err);
      }
    }
  }

  const ruleFindings = await runDeterministicRules(
    octokit,
    owner,
    repo,
    effectiveSha,
    files,
    reviewConfig,
  );

  const filesForLlm = files.filter((f) => {
    if (!f.patch || f.status === 'removed') return false;
    const hasRule = ruleFindings.some((r) => r.file === f.filename);
    return reviewConfig.mode === 'strict' || !hasRule;
  });

  let llmSummary: string | undefined;
  let llmFindings: ReviewFinding[] = [];

  if (filesForLlm.length > 0) {
    // Deep context: repo tree + files the changed code imports, so the model
    // can reason across files instead of judging hunks blind. ORVEX_DEEP_CONTEXT=0 disables.
    let reviewContext;
    if (process.env.ORVEX_DEEP_CONTEXT !== '0') {
      try {
        reviewContext = await buildRepoContext(
          octokit,
          owner,
          repo,
          effectiveSha,
          filesForLlm.map((f) => f.filename),
        );
        console.log(
          `[worker] deep context: ${reviewContext.changedContents.length} full files, ` +
            `${reviewContext.related.length} imports, ${reviewContext.dependents.length} dependents, ` +
            `tree=${reviewContext.treePaths.length}`,
        );
      } catch (err) {
        console.warn('[worker] deep context unavailable, reviewing diff-only:', err);
      }
    }

    const llm = await runLlmReview(filesForLlm, {
      apiKey: config.llmApiKey,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      maxTokens: Math.min(4096, Math.floor(reviewConfig.max_tokens / 10)),
      context: reviewContext,
    });
    llmSummary = llm.summary;
    llmFindings = llmFindingsToReviewFindings(llm.findings);
  }

  const incoming = dedupeByFileLine([...ruleFindings, ...llmFindings]);
  const merged = mergeFindings(incoming, verifiedOpen, effectiveSha, {
    minConfidence: reviewConfig.min_confidence,
  });

  // drop findings the team suppressed with `@orvex ignore`
  const suppressed = config.store.getSuppressedFingerprints(installationId, owner, repo);
  if (suppressed.size > 0) {
    merged.toPost = merged.toPost.filter((f) => !suppressed.has(fingerprintFinding(f)));
  }

  // snap finding lines to lines actually added in the diff — GitHub rejects
  // inline comments on unchanged lines; far-off guesses become summary-only
  const addedLinesByFile = buildAddedLineIndex(files);
  merged.toPost = merged.toPost.map((f) => normalizeFindingLine(f, addedLinesByFile));

  const allFixed = dedupeByFingerprint([...verifiedFixed, ...merged.newlyFixed]);
  const { inline, summaryOnly } = filterAndCapFindings(merged.toPost, reviewConfig);

  const stats = {
    newCount: merged.toPost.length,
    fixedCount: allFixed.length,
    openCount: merged.stillOpen.length + merged.toPost.length,
  };

  let reviewId: number | undefined;
  const commentIdMap = new Map<string, number>();

  if (merged.toPost.length > 0 || stats.fixedCount > 0) {
    const body = formatReviewBody(inline, summaryOnly, {
      owner,
      repo,
      pr: number,
      headSha: effectiveSha,
      stats,
      summary: llmSummary,
    });

    const inlineComments: InlineReviewComment[] = inline
      .filter((f) => f.line)
      .map((f) => ({
        path: f.file,
        line: f.line!,
        body: formatInlineBody(f),
      }));

    // Advisory by default: post as COMMENT (never blocks the PR). Set
    // ORVEX_REQUEST_CHANGES=1 to use REQUEST_CHANGES on P1 findings.
    const hasP1 = merged.toPost.some((f) => f.severity === 'P1');
    const event =
      hasP1 && process.env.ORVEX_REQUEST_CHANGES === '1' ? 'REQUEST_CHANGES' : 'COMMENT';
    const review = await postPullRequestReview(octokit, ref, effectiveSha, body, inlineComments, event);
    reviewId = review.reviewId;

    for (const c of review.commentIds) {
      commentIdMap.set(`${c.path}:${c.line}`, c.id);
    }
  } else if (stats.fixedCount > 0) {
    const body = formatReviewBody([], [], {
      owner,
      repo,
      pr: number,
      headSha: effectiveSha,
      stats,
      summary: `All previously reported issues appear fixed on \`${effectiveSha.slice(0, 7)}\`.`,
    });
    const review = await postPullRequestReview(octokit, ref, effectiveSha, body, [], 'COMMENT');
    reviewId = review.reviewId;
  }

  const newStored: StoredFinding[] = merged.toPost.map((f) => {
    const stored = toStoredFinding(f, effectiveSha);
    const key = f.line ? `${f.file}:${f.line}` : null;
    if (key && commentIdMap.has(key)) {
      stored.githubCommentId = commentIdMap.get(key);
    }
    return stored;
  });

  const fixedFps = new Set(allFixed.map((f) => f.fingerprint));

  const updatedPrior = (priorState?.findings ?? []).map((f) => {
    const fixed = allFixed.find((x) => x.fingerprint === f.fingerprint);
    if (fixed) return fixed;
    const still = merged.stillOpen.find((x) => x.fingerprint === f.fingerprint);
    if (still) return still;
    if (fixedFps.has(f.fingerprint)) {
      return { ...f, status: 'fixed' as const, fixedAtSha: effectiveSha };
    }
    return f;
  });

  const knownFps = new Set(updatedPrior.map((f) => f.fingerprint));
  const finalFindings = [
    ...updatedPrior,
    ...newStored.filter((s) => !knownFps.has(s.fingerprint)),
  ];

  const state: PrReviewState = {
    installationId,
    tenantId,
    owner,
    repo,
    pr: number,
    lastSha: effectiveSha,
    findings: finalFindings,
    lastReviewAt: new Date().toISOString(),
  };
  config.store.saveState(state);

  // update the dashboard PR row with the latest open-finding count
  const openCount = finalFindings.filter((f) => f.status === 'open').length;
  config.store.markReviewedNow(installationId, `${owner}/${repo}`, number, openCount);

  if (config.enableCheckRuns) {
    const openP1 = finalFindings.some((f) => f.status === 'open' && f.severity === 'P1');
    const openAny = finalFindings.some((f) => f.status === 'open');
    // Advisory: never fail the check (no red ✗). Findings show as 'neutral';
    // set ORVEX_FAIL_CHECK_ON_P1=1 to hard-fail on open P1s if you want gating.
    const conclusion =
      openP1 && process.env.ORVEX_FAIL_CHECK_ON_P1 === '1'
        ? 'failure'
        : openAny
          ? 'neutral'
          : 'success';
    await createCheckRun(octokit, ref, effectiveSha, {
      conclusion,
      title: 'Orvex Review',
      summary: `${stats.newCount} new, ${stats.fixedCount} fixed, ${stats.openCount} open`,
    });
  }

  console.log(
    `[worker] done PR #${number}: ${stats.newCount} new, ${stats.fixedCount} fixed, ${stats.openCount} open`,
  );

  return {
    findingCount: stats.openCount,
    newCount: stats.newCount,
    fixedCount: stats.fixedCount,
    reviewId,
  };
}

async function runDeterministicRules(
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

  return findings;
}

function formatInlineBody(f: ReviewFinding): string {
  return formatInlineFinding({
    finding: {
      severity: f.severity,
      ruleId: f.ruleId,
      message: f.message,
      suggestion: f.suggestion,
      originalCode: f.originalCode,
      fixedCode: f.fixedCode,
      fingerprint: fingerprintFinding(f),
    },
    trigger: commandTrigger(),
  });
}

function dedupeByFingerprint(findings: StoredFinding[]): StoredFinding[] {
  const byFp = new Map<string, StoredFinding>();
  for (const f of findings) {
    byFp.set(f.fingerprint, f);
  }
  return [...byFp.values()];
}

type AddedLineMap = Map<string, Set<number>>;

function buildAddedLineIndex(files: Array<{ filename: string; patch?: string }>): AddedLineMap {
  const map: AddedLineMap = new Map();
  for (const file of files) {
    if (!file.patch) continue;
    const lines = parseAddedLinesFromPatch(file.patch);
    if (lines.size > 0) {
      map.set(file.filename, lines);
    }
  }
  return map;
}

function parseAddedLinesFromPatch(patch: string): Set<number> {
  const added = new Set<number>();
  let newLine = 0;

  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (match) {
      newLine = Number(match[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (newLine > 0) added.add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      continue;
    }
    if (newLine > 0) {
      newLine += 1;
    }
  }

  return added;
}

function normalizeFindingLine(finding: ReviewFinding, addedLinesByFile: AddedLineMap): ReviewFinding {
  const candidateLines = addedLinesByFile.get(finding.file);
  // file not part of the diff's added lines (pure deletion / unchanged) → summary-only
  if (!candidateLines || candidateLines.size === 0) {
    return { ...finding, line: undefined };
  }
  // exact hit
  if (finding.line && candidateLines.has(finding.line)) {
    return finding;
  }
  // Anchor to the nearest changed line in the same file so the finding still
  // gets an inline comment (and its fix checkbox). GitHub only accepts inline
  // comments on changed lines; a slightly-off anchor is far better than hiding
  // the finding — and its fix button — in a summary table.
  const anchor = nearestAddedLine(candidateLines, finding.line);
  return { ...finding, line: anchor };
}

/** Nearest changed line to `requested`, or the first changed line if no hint. */
function nearestAddedLine(addedLines: Set<number>, requested?: number): number {
  const sorted = [...addedLines];
  if (!requested) return Math.min(...sorted);
  let bestLine = sorted[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const addedLine of sorted) {
    const distance = Math.abs(addedLine - requested);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLine = addedLine;
      if (distance === 0) break;
    }
  }
  return bestLine;
}
