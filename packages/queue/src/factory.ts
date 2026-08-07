import type { ReviewQueue } from './types.js';
import { MemoryReviewQueue } from './memory.js';
import { RedisReviewQueue } from './redis.js';

export function createReviewQueue(): ReviewQueue {
  const backend = (process.env.QUEUE_BACKEND ?? (process.env.NODE_ENV === 'production' ? 'redis' : 'memory')).toLowerCase();
  if (backend === 'redis') {
    const url = process.env.REDIS_URL;
    if (!url && process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_URL is required for the production review queue');
    }
    return new RedisReviewQueue(url ?? 'redis://127.0.0.1:6379');
  }
  if (process.env.NODE_ENV === 'production' && process.env.ORVEX_ALLOW_MEMORY_QUEUE !== '1') {
    throw new Error('QUEUE_BACKEND=memory is not allowed in production; configure Redis or explicitly set ORVEX_ALLOW_MEMORY_QUEUE=1');
  }
  return new MemoryReviewQueue();
}
