import type { ReviewQueue } from './types.js';
import { MemoryReviewQueue } from './memory.js';
import { RedisReviewQueue } from './redis.js';

export function createReviewQueue(): ReviewQueue {
  const backend = process.env.QUEUE_BACKEND ?? 'memory';
  if (backend === 'redis') {
    const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    return new RedisReviewQueue(url);
  }
  return new MemoryReviewQueue();
}
