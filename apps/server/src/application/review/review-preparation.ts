import {
  buildRepoContext,
  createCappedArchiveStream,
  createInstallationOctokit,
  fetchFileContent,
  fetchPrDiffWithCoverage,
  fetchPrLabels,
  fetchPullRequest,
  fetchRepoFile,
  hasIgnoreLabel,
  shouldSkipPr,
} from '@orvex-review/github';
import type { ReviewJobPayload } from '@orvex-review/queue';
import { isHighRiskDiff, reconcileFixedOnHead } from '@orvex-review/review';
import { planFeatures } from '@orvex-review/tenants';
import { parseReviewConfigYaml, type ReviewConfig } from '@orvex-review/rules';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { noteActiveCheckoutDir } from '../../active-reviews.js';
import type { WorkerConfig } from '../../review/worker-types.js';
import { runDeterministicRules } from './finding-pipeline.js';
import type { PreparedExecutionReview } from './types.js';

export interface ReviewPreparationPolicy {
  deepContextEnabled: boolean;
  contextSourceFiles: number;
  contextRelatedFiles: number;
  contextDependents: number;
  contextFileBytes: number;
  riskContextBoost: boolean;
  archiveMaxBytes: number;
}

export const DEFAULT_REVIEW_PREPARATION_POLICY: ReviewPreparationPolicy = {
  deepContextEnabled: true,
  contextSourceFiles: 40,
  contextRelatedFiles: 12,
  contextDependents: 8,
  contextFileBytes: 120_000,
  riskContextBoost: false,
  archiveMaxBytes: 150_000_000,
};

export interface ReviewPreparationDependencies {
  persistJob?: (job: ReviewJobPayload) => Promise<void>;
  policy?: ReviewPreparationPolicy;
  github?: {
    createClient: typeof createInstallationOctokit;
    fetchPullRequest: typeof fetchPullRequest;
    fetchPrLabels: typeof fetchPrLabels;
    fetchRepoFile: typeof fetchRepoFile;
    fetchPrDiffWithCoverage: typeof fetchPrDiffWithCoverage;
    fetchFileContent: typeof fetchFileContent;
    buildRepoContext: typeof buildRepoContext;
  };
}

/**
 * Establishes the durable handoff from queue work to review computation. The
 * run id is written before any provider call so shutdown recovery owns the
 * same reservation instead of creating a second billed run.
 */
export class ReviewPreparation {
  constructor(private readonly dependencies: ReviewPreparationDependencies = {}) {}

  checkoutRepoForAgent(
    octokit: ReturnType<typeof createInstallationOctokit>,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<string | null> {
    return checkoutRepoForAgent(
      octokit,
      owner,
      repo,
      ref,
      (this.dependencies.policy ?? DEFAULT_REVIEW_PREPARATION_POLICY).archiveMaxBytes,
    );
  }

  async prepare(
    job: ReviewJobPayload,
    config: WorkerConfig,
    runId: string,
  ): Promise<PreparedExecutionReview> {
    job.runId = runId;
    await this.dependencies.persistJob?.(job);
    const policy = this.dependencies.policy ?? DEFAULT_REVIEW_PREPARATION_POLICY;
    const github = this.dependencies.github ?? {
      createClient: createInstallationOctokit,
      fetchPullRequest,
      fetchPrLabels,
      fetchRepoFile,
      fetchPrDiffWithCoverage,
      fetchFileContent,
      buildRepoContext,
    };
    const { installationId, tenantId, owner, repo, pr: number, action } = job;
    const ref = { owner, repo, number };
    const octokit = github.createClient(config.github, installationId);
    const pr = await github.fetchPullRequest(octokit, ref);
    const effectiveSha = pr.headSha;
    if (effectiveSha !== job.headSha) {
      console.log(
        `[worker] head moved ${job.headSha.slice(0, 7)} → ${effectiveSha.slice(0, 7)} since enqueue; recording run on effective SHA`,
      );
      if (!config.store.setReviewRunHeadSha(runId, effectiveSha)) {
        throw new Error('review run ownership lost before head synchronization');
      }
    }

    const labels = await github.fetchPrLabels(octokit, ref);
    let repoConfigYaml: string | null = null;
    try {
      const configRef = pr.baseSha || effectiveSha;
      repoConfigYaml =
        (await github.fetchRepoFile(octokit, owner, repo, '.orvex-review.yml', configRef)) ??
        (await github.fetchRepoFile(octokit, owner, repo, '.velatrix-review.yml', configRef));
    } catch (error) {
      console.error(
        `[worker] repo config fetch failed, using defaults: ${(error as Error).message}`,
      );
    }
    const reviewConfig = effectiveReviewConfig(
      repoConfigYaml,
      config.store.getWorkspaceSettings(tenantId),
      config.store.getRepoByFullName(installationId, `${owner}/${repo}`)?.reviewMode,
    );

    const base = {
      job,
      config,
      runId,
      ref,
      octokit,
      pr,
      effectiveSha,
      reviewConfig,
      priorState: null,
      files: [],
      coverage: {
        candidates: 0,
        reviewed: 0,
        skippedByCap: 0,
        truncatedFiles: 0,
        deletedFiles: 0,
        omittedPatch: 0,
        complete: true,
      },
      verifiedOpen: [],
      verifiedFixed: [],
      readErrorFps: new Set<string>(),
      ruleFindings: [],
      filesForLlm: [],
      filesForInvestigate: [],
      highRiskDiff: false,
      reviewContextFiles: [],
      repoTreePaths: [],
    } satisfies PreparedExecutionReview;
    if (hasIgnoreLabel(labels, reviewConfig.ignore_labels)) {
      console.log(`[worker] skip PR #${number}: label ${reviewConfig.ignore_labels.join('/')}`);
      return {
        ...base,
        skipResult: { findingCount: 0, newCount: 0, fixedCount: 0, skipReason: 'ignore_label' },
      };
    }
    const skipReason = shouldSkipPr(pr, {
      botLogin: config.github.botLogin,
      allowDraft: action === 'command' || action === 'manual',
    });
    if (skipReason) {
      console.log(`[worker] skip PR #${number}: ${skipReason}`);
      return { ...base, skipResult: { findingCount: 0, newCount: 0, fixedCount: 0, skipReason } };
    }

    const priorState = config.store.getState({ installationId, owner, repo, pr: number });
    const sinceSha =
      action === 'synchronize' && priorState?.lastSha ? priorState.lastSha : undefined;
    const { files, coverage } = await github.fetchPrDiffWithCoverage(octokit, ref, {
      maxFileBytes: config.maxFileBytes,
      maxFiles: config.maxFiles,
      ignoreGlobs: reviewConfig.ignore,
      sinceSha,
      headSha: effectiveSha,
    });
    if (!coverage.complete) {
      console.warn(
        `[worker] PARTIAL coverage ${owner}/${repo}#${number}: ${coverage.reviewed}/${coverage.candidates} files reviewed, ${coverage.skippedByCap} over cap, ${coverage.truncatedFiles} truncated, ${coverage.omittedPatch} patch-omitted`,
      );
    }
    console.log(
      `[worker] PR #${number} @ ${effectiveSha.slice(0, 7)} action=${action} files=${files.length}` +
        (sinceSha
          ? ` incremental ${sinceSha.slice(0, 7)}..${effectiveSha.slice(0, 7)}`
          : ' full diff'),
    );

    const priorOpen = (priorState?.findings ?? []).filter((finding) => finding.status === 'open');
    const {
      stillOpen: verifiedOpen,
      newlyFixed: verifiedFixed,
      readErrorFps,
    } = await reconcileFixedOnHead(priorOpen, effectiveSha, {
      readFile: (filePath, refName) =>
        github.fetchFileContent(octokit, owner, repo, filePath, refName),
    });
    const ruleFindings = await runDeterministicRules(
      octokit,
      owner,
      repo,
      effectiveSha,
      files,
      reviewConfig,
    );
    const filesForLlm = files.filter((file) => Boolean(file.patch) && file.status !== 'removed');
    const filesForInvestigate = files.filter((file) => Boolean(file.patch));
    const highRiskDiff = isHighRiskDiff(filesForLlm);
    let reviewContext;
    let reviewContextFiles: Array<{ path: string; content: string }> = [];
    let repoTreePaths: string[] = [];
    if (filesForLlm.length > 0 && policy.deepContextEnabled) {
      try {
        reviewContext = await github.buildRepoContext(
          octokit,
          owner,
          repo,
          effectiveSha,
          filesForLlm.map((file) => file.filename),
          {
            maxSourceFiles: policy.contextSourceFiles,
            maxRelated:
              policy.contextRelatedFiles + (highRiskDiff && policy.riskContextBoost ? 6 : 0),
            maxDependents:
              policy.contextDependents + (highRiskDiff && policy.riskContextBoost ? 4 : 0),
            maxFileBytes: policy.contextFileBytes,
            maxOthers:
              planFeatures(config.store.getTenantPlan(tenantId)).retrievalTopK +
              (highRiskDiff && policy.riskContextBoost ? 8 : 0) +
              (planFeatures(config.store.getTenantPlan(tenantId)).repoSweep
                ? planFeatures(config.store.getTenantPlan(tenantId)).sweepMaxFiles
                : 0),
          },
        );
        console.log(
          `[worker] deep context: ${reviewContext.changedContents.length} full files, ` +
            `${reviewContext.related.length} imports, ${reviewContext.dependents.length} dependents, ` +
            `${reviewContext.others.length} index-retrieved relevant files, tree=${reviewContext.treePaths.length}`,
        );
        reviewContextFiles = [
          ...reviewContext.changedContents,
          ...reviewContext.related,
          ...reviewContext.dependents,
          ...reviewContext.others,
        ];
        repoTreePaths = reviewContext.treePaths ?? [];
      } catch (error) {
        console.warn('[worker] deep context unavailable, reviewing diff-only:', error);
      }
    }

    return {
      ...base,
      priorState,
      files,
      coverage,
      verifiedOpen,
      verifiedFixed,
      readErrorFps: new Set(readErrorFps),
      ruleFindings,
      filesForLlm,
      filesForInvestigate,
      highRiskDiff,
      reviewContext,
      reviewContextFiles,
      repoTreePaths,
    };
  }
}
export async function checkoutRepoForAgent(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  ref: string,
  archiveMaxBytes = DEFAULT_REVIEW_PREPARATION_POLICY.archiveMaxBytes,
): Promise<string | null> {
  let dir: string | null = null;
  try {
    const maxArchiveBytes =
      Number.isFinite(archiveMaxBytes) && archiveMaxBytes > 0
        ? Math.min(Math.floor(archiveMaxBytes), 500_000_000)
        : DEFAULT_REVIEW_PREPARATION_POLICY.archiveMaxBytes;
    const res = await octokit.rest.repos.downloadTarballArchive({
      owner,
      repo,
      ref,
      request: { parseSuccessResponseBody: false },
    });
    // This is the only host directory mounted into the agentic container.
    // Keep the established sandbox prefix and private mode so arbitrary temp
    // directories can never be bind-mounted by the Codex runner.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-rverify-'));
    fs.chmodSync(dir, 0o700);
    const tarPath = path.join(dir, 'repo.tar.gz');
    await streamPipeline(
      createCappedArchiveStream(res.data, maxArchiveBytes),
      fs.createWriteStream(tarPath, { mode: 0o600 }),
    );
    // GitHub tarballs nest everything under a top-level `owner-repo-sha/` dir.
    execFileSync(
      'tar',
      [
        '-xzf',
        tarPath,
        '-C',
        dir,
        '--strip-components=1',
        '--no-same-owner',
        '--no-same-permissions',
      ],
      { stdio: 'ignore' },
    );
    fs.rmSync(tarPath, { force: true });
    noteActiveCheckoutDir(dir);
    // Keep Codex from pulling build artifacts / lockfiles into the tool loop —
    // those dumps are a common path to "Request too large" during compact.
    try {
      fs.writeFileSync(
        path.join(dir, '.codexignore'),
        [
          'node_modules/',
          'dist/',
          'build/',
          'out/',
          '.git/',
          'coverage/',
          '.next/',
          '.turbo/',
          '.cache/',
          'vendor/',
          '*.lock',
          'package-lock.json',
          'pnpm-lock.yaml',
          'yarn.lock',
          'Bun.lockb',
          '*.min.js',
          '*.min.css',
          '*.map',
          '*.png',
          '*.jpg',
          '*.jpeg',
          '*.gif',
          '*.webp',
          '*.woff',
          '*.woff2',
          '*.ttf',
          '*.eot',
          '*.pdf',
          '*.zip',
          '*.tar',
          '*.gz',
          '',
        ].join('\n'),
        { mode: 0o644 },
      );
    } catch (err) {
      console.warn('[worker] failed to write .codexignore:', (err as Error).message);
    }
    return dir;
  } catch (err) {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    console.warn('[worker] repo checkout failed:', (err as Error).message);
    return null;
  }
}

export function effectiveReviewConfig(
  repoConfigYaml: string | null,
  workspace: { defaultReviewMode: 'normal' | 'strict'; maxComments: number },
  repoReviewMode?: 'normal' | 'strict',
): ReviewConfig {
  const parsed = parseReviewConfigYaml(repoConfigYaml);
  if (repoConfigYaml?.trim()) return parsed;
  return {
    ...parsed,
    mode: repoReviewMode ?? workspace.defaultReviewMode,
    max_comments: workspace.maxComments,
  };
}
