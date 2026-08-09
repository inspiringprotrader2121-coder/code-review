import { createReviewQueue, type ReviewQueue } from '@orvex-review/queue';
import {
  configureLlmProviderCoordinator,
  type LlmProviderCoordinator,
} from '@orvex-review/review';
import { createAppDatabase, type AppDatabase } from '@orvex-review/store';
import { createApp } from '../app.js';
import type { ServerRuntimeConfig } from './config.js';

export interface AppServices {
  db: AppDatabase;
  queue: ReviewQueue;
  app: ReturnType<typeof createApp>;
}

export interface CompositionFactories {
  db?: AppDatabase;
  queue?: ReviewQueue;
  configureProviderCoordinator?: (coordinator?: LlmProviderCoordinator) => void;
}

export function composeApplication(
  config: ServerRuntimeConfig,
  factories: CompositionFactories = {},
): AppServices {
  const db = factories.db ?? createAppDatabase();
  const queue = factories.queue ?? createReviewQueue();
  const coordinator = (
    queue.acquireProviderLease
    && queue.releaseProviderLease
    && queue.getProviderCooldownMs
    && queue.setProviderCooldown
  ) ? queue as LlmProviderCoordinator : undefined;
  (factories.configureProviderCoordinator ?? configureLlmProviderCoordinator)(coordinator);
  const app = createApp(queue, { db, codexStatusFile: config.codexStatusFile });
  return { db, queue, app };
}
