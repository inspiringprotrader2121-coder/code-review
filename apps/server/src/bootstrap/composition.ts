import {
  configureGitHubRequestPacer,
  MemoryGitHubInstallationPacer,
  type GitHubInstallationPacer,
} from '@orvex-review/github';
import {
  createReviewQueue,
  providerAdmissionFor,
  RedisGitHubInstallationPacer,
  type ReviewQueueRuntime,
} from '@orvex-review/queue';
import { configureLlmProviderCoordinator, type LlmProviderCoordinator } from '@orvex-review/review';
import { createAppDatabase, type AppDatabase } from '@orvex-review/store';
import { createApp } from '../app.js';
import { githubAppConfig, type ServerConfig } from './config.js';
import { providerCapacityPlanFor } from './provider-capacity.js';

export interface AppServices {
  db: AppDatabase;
  queue: ReviewQueueRuntime;
  app: ReturnType<typeof createApp>;
  githubPacer?: GitHubInstallationPacer;
}

export interface CompositionFactories {
  db?: AppDatabase;
  queue?: ReviewQueueRuntime;
  configureProviderCoordinator?: (
    coordinator?: LlmProviderCoordinator,
    localProviderConcurrency?: (provider: string) => number,
    admissionWaitMs?: number,
  ) => void;
  configureGitHubPacer?: (pacer?: GitHubInstallationPacer) => void;
  githubPacer?: GitHubInstallationPacer;
}

export function composeApplication(
  config: ServerConfig,
  factories: CompositionFactories = {},
): AppServices {
  const db = factories.db ?? createAppDatabase(config.store);
  const queue =
    factories.queue ??
    createReviewQueue(config.queue, { providerCapacityPlan: providerCapacityPlanFor(config) });
  const coordinator = providerAdmissionFor(queue) ?? undefined;
  (factories.configureProviderCoordinator ?? configureLlmProviderCoordinator)(
    coordinator,
    config.review.providerConcurrency,
    config.queue.providerLeaseWaitMs,
  );
  const githubPacer = factories.githubPacer ?? createGitHubPacer(config);
  (factories.configureGitHubPacer ?? configureGitHubRequestPacer)(githubPacer);
  const githubConfig = githubAppConfig(config);
  const app = createApp(queue, { db, config, githubConfig });
  return { db, queue, app, githubPacer };
}

function createGitHubPacer(config: ServerConfig): GitHubInstallationPacer {
  const pace = {
    tokensPerSecond: config.github.paceTokensPerSecond,
    burst: config.github.paceBurst,
  };
  if (config.queue.backend === 'redis' && config.queue.redisUrl) {
    return new RedisGitHubInstallationPacer(config.queue.redisUrl, {
      namespace: config.queue.redisNamespace,
      ...pace,
    });
  }
  return new MemoryGitHubInstallationPacer(pace);
}
