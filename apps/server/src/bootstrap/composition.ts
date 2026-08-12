import {
  createReviewQueue,
  providerAdmissionFor,
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
}

export interface CompositionFactories {
  db?: AppDatabase;
  queue?: ReviewQueueRuntime;
  configureProviderCoordinator?: (
    coordinator?: LlmProviderCoordinator,
    localProviderConcurrency?: (provider: string) => number,
    admissionWaitMs?: number,
  ) => void;
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
  const githubConfig = githubAppConfig(config);
  const app = createApp(queue, { db, config, githubConfig });
  return { db, queue, app };
}
