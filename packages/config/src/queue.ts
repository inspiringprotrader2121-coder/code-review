import { boundedInteger, optionalString } from './values.js';

export interface QueueConfig {
  backend: 'memory' | 'redis';
  production: boolean;
  allowMemoryInProduction: boolean;
  redisUrl: string | null;
  redisNamespace: string;
  maxResumeAfterRestart: number;
  providerLeaseWaitMs: number;
  maxMemoryDedupEntries: number;
}

export function loadQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const production = env.NODE_ENV === 'production';
  const backend = (env.QUEUE_BACKEND ?? (production ? 'redis' : 'memory')).toLowerCase();
  if (backend !== 'memory' && backend !== 'redis') {
    throw new Error(`Unsupported QUEUE_BACKEND=${backend}; expected memory or redis`);
  }
  return Object.freeze({
    backend,
    production,
    allowMemoryInProduction: env.ORVEX_ALLOW_MEMORY_QUEUE === '1',
    redisUrl: optionalString(env.REDIS_URL) ?? (production ? null : 'redis://127.0.0.1:6379'),
    redisNamespace: optionalString(env.ORVEX_QUEUE_NAMESPACE) ?? 'orvex-review',
    maxResumeAfterRestart: boundedInteger(env.ORVEX_MAX_RESUME_AFTER_RESTART, 0, 0, 10),
    providerLeaseWaitMs: boundedInteger(
      env.ORVEX_PROVIDER_LEASE_WAIT_MS,
      600_000,
      1_000,
      3_600_000,
    ),
    maxMemoryDedupEntries: boundedInteger(env.ORVEX_QUEUE_MAX_DEDUP, 20_000, 1, 1_000_000),
  });
}
