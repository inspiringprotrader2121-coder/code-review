import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import type { GitHubAppConfig } from './types.js';
import { currentGitHubRequestPacer, type GitHubInstallationPacer } from './pacer.js';
import { parseGitHubRetryAfterMs } from './retry.js';

const ThrottledOctokit = Octokit.plugin(throttling);

export interface CreateInstallationOctokitOptions {
  pacer?: GitHubInstallationPacer;
  /** Max plugin-level retries for primary/secondary rate limits. */
  maxRetries?: number;
}

/**
 * Installation Octokit with @octokit/plugin-throttling plus optional
 * per-installation token-bucket pacing (Redis in production).
 */
export function createThrottledInstallationOctokit(
  config: GitHubAppConfig,
  installationId: number,
  options: CreateInstallationOctokitOptions = {},
): Octokit {
  const pacer = options.pacer ?? currentGitHubRequestPacer();
  const maxRetries = Math.min(5, Math.max(0, Math.floor(options.maxRetries ?? 3)));
  let pendingFreeze: Promise<void> = Promise.resolve();

  const octokit = new ThrottledOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId,
    },
    throttle: {
      onRateLimit: (retryAfter, _options, _octokit, retryCount) => {
        const waitMs = Math.max(0, Math.floor(retryAfter * 1000));
        pendingFreeze = Promise.resolve(pacer?.noteRetryAfter?.(installationId, waitMs)).then(
          () => undefined,
        );
        console.warn(
          `[github] primary rate limit for installation ${installationId}; retry-after ${retryAfter}s (attempt ${retryCount + 1}/${maxRetries + 1})`,
        );
        return retryCount < maxRetries;
      },
      onSecondaryRateLimit: (retryAfter, _options, _octokit, retryCount) => {
        const waitMs = Math.max(0, Math.floor(retryAfter * 1000));
        pendingFreeze = Promise.resolve(pacer?.noteRetryAfter?.(installationId, waitMs)).then(
          () => undefined,
        );
        console.warn(
          `[github] secondary rate limit for installation ${installationId}; retry-after ${retryAfter}s (attempt ${retryCount + 1}/${maxRetries + 1})`,
        );
        return retryCount < maxRetries;
      },
    },
  });

  if (pacer) {
    octokit.hook.before('request', async (requestOptions) => {
      await pendingFreeze;
      const signal =
        requestOptions.request && typeof requestOptions.request === 'object'
          ? (requestOptions.request as { signal?: AbortSignal }).signal
          : undefined;
      await pacer.acquire(installationId, signal);
    });
    octokit.hook.error('request', async (error) => {
      const waitMs = parseGitHubRetryAfterMs(error);
      if (waitMs !== undefined) {
        await pacer.noteRetryAfter?.(installationId, waitMs);
      }
      throw error;
    });
  }

  return octokit as Octokit;
}
