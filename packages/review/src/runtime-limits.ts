const DEFAULT_PARALLELISM = 8;
const MAX_PROVIDER_PARALLELISM = 32;
const MAX_WORKER_PARALLELISM = 100;

function boundedInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(1, Math.floor(parsed)))
    : fallback;
}

/** Parallel Codex processes sharing one API-key home. OAuth homes stay serial. */
export function resolveCodexApiKeyConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return boundedInteger(
    env.ORVEX_CODEX_APIKEY_CONCURRENCY,
    boundedInteger(env.ORVEX_MAX_CONCURRENT_REVIEWS, DEFAULT_PARALLELISM, MAX_PROVIDER_PARALLELISM),
    MAX_PROVIDER_PARALLELISM,
  );
}

/** Concurrent review jobs owned by one worker process. */
export function resolveReviewWorkerConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return boundedInteger(
    env.ORVEX_MAX_CONCURRENT_REVIEWS,
    DEFAULT_PARALLELISM,
    MAX_WORKER_PARALLELISM,
  );
}

/** Concurrent calls for one provider bucket in this process. */
export function resolveProviderConcurrency(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const sharedCapacity = env.ORVEX_CODEX_CLI === '1'
    ? resolveCodexApiKeyConcurrency(env)
    : boundedInteger(
      env.ORVEX_MAX_CONCURRENT_REVIEWS,
      DEFAULT_PARALLELISM,
      MAX_PROVIDER_PARALLELISM,
    );
  return boundedInteger(
    env[`ORVEX_PROVIDER_CONCURRENCY_${normalized}`],
    sharedCapacity,
    MAX_PROVIDER_PARALLELISM,
  );
}
