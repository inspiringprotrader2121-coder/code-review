import {
  createInstallationOctokit,
  createCheckRun,
  fetchFileContent,
  fetchPrDiff,
  fetchPrLabels,
  fetchPullRequest,
  fetchRepoFile,
  getInstallationIdForRepo,
  hasIgnoreLabel,
  isRepoAllowed,
  loadGitHubConfigFromEnv,
  postPullRequestReview,
  replyToReviewComment,
  shouldSkipPr,
  type GitHubAppConfig,
  type InlineReviewComment,
} from '@velatrix-review/github';
import type { ReviewJobPayload } from '@velatrix-review/queue';
import {
  auditFindingsFromContent,
  parseReviewConfigYaml,
  runSemgrepOnPaths,
  shouldIgnorePath,
  type ReviewConfig,
} from '@velatrix-review/rules';
import {
  dedupeByFileLine,
  filterAndCapFindings,
  formatFixedReply,
  formatReviewBody,
  llmFindingsToReviewFindings,
  mergeFindings,
  reconcileFixedOnHead,
  runLlmReview,
  toStoredFinding,
  type ReviewFinding,
} from '@velatrix-review/review';
import {
  createReviewStore,
  type PrReviewState,
  type SqliteReviewStore,
  type StoredFinding,
} from '@velatrix-review/store';

export interface WorkerConfig {
  github: GitHubAppConfig;
  anthropicApiKey: string;
  anthropicModel: string;
  maxFileBytes: number;
  maxFiles: number;
  enableCheckRuns: boolean;
  store: SqliteReviewStore;
}

let sharedStore: SqliteReviewStore | null = null;

export function loadWorkerConfig(): WorkerConfig {
  const github = loadGitHubConfigFromEnv();
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  if (!sharedStore) {
    sharedStore = createReviewStore();
  }

  return {
    github,
    anthropicApiKey,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
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
}

export async function processReviewJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const { owner, repo, pr: number, action } = job;
  const ref = { owner, repo, number };

  if (!isRepoAllowed(owner, repo, config.github.allowedRepo)) {
    throw new Error(`Repo ${owner}/${repo} not in GITHUB_ALLOWED_REPO allowlist`);
  }

  const installationId = await getInstallationIdForRepo(config.github, owner, repo);
  const octokit = createInstallationOctokit(config.github, installationId);

  const pr = await fetchPullRequest(octokit, ref);
  const effectiveSha = pr.headSha;

  const labels = await fetchPrLabels(octokit, ref);
  const repoConfigYaml = await fetchRepoFile(
    octokit,
    owner,
    repo,
    '.velatrix-review.yml',
    effectiveSha,
  );
  const reviewConfig = parseReviewConfigYaml(repoConfigYaml);

  if (hasIgnoreLabel(labels, reviewConfig.ignore_labels)) {
    console.log(`[worker] skip PR #${number}: label ${reviewConfig.ignore_labels.join('/')}`);
    return { findingCount: 0, newCount: 0, fixedCount: 0 };
  }

  const skipReason = shouldSkipPr(pr, { botLogin: config.github.botLogin });
  if (skipReason) {
    console.log(`[worker] skip PR #${number}: ${skipReason}`);
    return { findingCount: 0, newCount: 0, fixedCount: 0 };
  }

  const priorState = config.store.getState({ owner, repo, pr: number });
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
    const llm = await runLlmReview(filesForLlm, {
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      maxTokens: Math.min(4096, Math.floor(reviewConfig.max_tokens / 10)),
    });
    llmSummary = llm.summary;
    llmFindings = llmFindingsToReviewFindings(llm.findings);
  }

  const incoming = dedupeByFileLine([...ruleFindings, ...llmFindings]);
  const merged = mergeFindings(incoming, verifiedOpen, effectiveSha, {
    minConfidence: reviewConfig.min_confidence,
  });

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

    const hasP1 = merged.toPost.some((f) => f.severity === 'P1');
    const review = await postPullRequestReview(
      octokit,
      ref,
      effectiveSha,
      body,
      inlineComments,
      hasP1 ? 'REQUEST_CHANGES' : 'COMMENT',
    );
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
    owner,
    repo,
    pr: number,
    lastSha: effectiveSha,
    findings: finalFindings,
    lastReviewAt: new Date().toISOString(),
  };
  config.store.saveState(state);

  if (config.enableCheckRuns) {
    const openP1 = finalFindings.some((f) => f.status === 'open' && f.severity === 'P1');
    const openAny = finalFindings.some((f) => f.status === 'open');
    await createCheckRun(octokit, ref, effectiveSha, {
      conclusion: openP1 ? 'failure' : openAny ? 'neutral' : 'success',
      title: 'Velatrix Review',
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
  const parts = [`**${f.severity}** · \`${f.ruleId}\``, '', f.message];
  if (f.suggestion) parts.push('', f.suggestion);
  return parts.join('\n');
}

function dedupeByFingerprint(findings: StoredFinding[]): StoredFinding[] {
  const byFp = new Map<string, StoredFinding>();
  for (const f of findings) {
    byFp.set(f.fingerprint, f);
  }
  return [...byFp.values()];
}
