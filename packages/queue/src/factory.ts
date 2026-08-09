import { loadQueueConfig, type QueueConfig } from '@orvex-review/config';
import type { ReviewQueueRuntime } from './types.js';
import { MemoryReviewQueue } from './memory.js';
import { RedisReviewQueue } from './redis.js';

export type ReviewQueueConfig = QueueConfig;
export const loadReviewQueueConfig = loadQueueConfig;

export function createReviewQueue(
  config: ReviewQueueConfig = loadReviewQueueConfig(),
): ReviewQueueRuntime {
  const { backend } = config;
  if (backend === 'redis') {
    if (!config.redisUrl) {
      throw new Error('REDIS_URL is required for the production review queue');
    }
    return new RedisReviewQueue(config.redisUrl, {
      namespace: config.redisNamespace,
      maxResumeAfterRestart: config.maxResumeAfterRestart,
      providerLeaseWaitMs: config.providerLeaseWaitMs,
    });
  }
  if (config.production && !config.allowMemoryInProduction) {
    throw new Error(
      'QUEUE_BACKEND=memory is not allowed in production; configure Redis or explicitly set ORVEX_ALLOW_MEMORY_QUEUE=1',
    );
  }
  return new MemoryReviewQueue({ maxDedupEntries: config.maxMemoryDedupEntries });
}
