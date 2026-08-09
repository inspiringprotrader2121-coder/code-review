import { loadReviewRuntimeConfig } from '@orvex-review/config';

/** Parallel Codex processes sharing one API-key home. OAuth homes stay serial. */
export function resolveCodexApiKeyConcurrency(env?: NodeJS.ProcessEnv): number {
  return loadReviewRuntimeConfig(env).codexApiKeyConcurrency;
}

/** Concurrent review jobs owned by one worker process. */
export function resolveReviewWorkerConcurrency(env?: NodeJS.ProcessEnv): number {
  return loadReviewRuntimeConfig(env).reviewWorkerConcurrency;
}

/** Concurrent calls for one provider bucket in this process. */
export function resolveProviderConcurrency(provider: string, env?: NodeJS.ProcessEnv): number {
  return loadReviewRuntimeConfig(env).providerConcurrency(provider);
}
