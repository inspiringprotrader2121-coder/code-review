import {
  createInstallationOctokit,
  fetchPrDiff,
  fetchPullRequest,
  getInstallationIdForRepo,
  isRepoAllowed,
  loadGitHubConfigFromEnv,
  postPrComment,
  shouldSkipPr,
  type GitHubAppConfig,
} from '@velatrix-review/github';
import type { ReviewJobPayload } from '@velatrix-review/queue';
import { formatReviewComment, runLlmReview } from '@velatrix-review/review';

export interface WorkerConfig {
  github: GitHubAppConfig;
  anthropicApiKey: string;
  anthropicModel: string;
  maxFileBytes: number;
  maxFiles: number;
}

export function loadWorkerConfig(): WorkerConfig {
  const github = loadGitHubConfigFromEnv();
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  return {
    github,
    anthropicApiKey,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
    maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 120_000),
    maxFiles: Number(process.env.MAX_FILES ?? 40),
  };
}

export async function processReviewJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
): Promise<{ commentId: number; findingCount: number }> {
  const { owner, repo, pr: number, headSha } = job;
  const ref = { owner, repo, number };

  if (!isRepoAllowed(owner, repo, config.github.allowedRepo)) {
    throw new Error(`Repo ${owner}/${repo} not in GITHUB_ALLOWED_REPO allowlist`);
  }

  const installationId = await getInstallationIdForRepo(config.github, owner, repo);
  const octokit = createInstallationOctokit(config.github, installationId);

  const pr = await fetchPullRequest(octokit, ref);
  if (pr.headSha !== headSha) {
    console.warn(`[worker] head sha drift: job=${headSha} pr=${pr.headSha}`);
  }

  const skipReason = shouldSkipPr(pr, { botLogin: config.github.botLogin });
  if (skipReason) {
    console.log(`[worker] skip PR #${number}: ${skipReason}`);
    const body = `## Velatrix Review\n\nSkipped: ${skipReason}.`;
    const commentId = await postPrComment(octokit, ref, body);
    return { commentId, findingCount: 0 };
  }

  const files = await fetchPrDiff(octokit, ref, {
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles,
  });

  console.log(`[worker] PR #${number} @ ${headSha.slice(0, 7)} — ${files.length} files`);

  const review = await runLlmReview(files, {
    apiKey: config.anthropicApiKey,
    model: config.anthropicModel,
  });

  const body = formatReviewComment(review.findings, {
    owner,
    repo,
    pr: number,
    headSha,
    summary: review.summary,
  });

  const commentId = await postPrComment(octokit, ref, body);
  console.log(`[worker] posted comment ${commentId} (${review.findings.length} findings)`);

  return { commentId, findingCount: review.findings.length };
}
