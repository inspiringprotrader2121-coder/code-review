import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { currentEnvironment, loadReviewRuntimeConfig } from '@orvex-review/config';
import { ReviewCancelledError } from '../llm-client.js';
import type { Clock } from '../providers/types.js';
import type { CodexAuthMode } from './contracts.js';

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function codexAllowedRepos(env?: NodeJS.ProcessEnv): string[] {
  return [...loadReviewRuntimeConfig(env).codexAllowedRepos];
}

export function isCodexRepoAllowed(repoId: string | undefined, env?: NodeJS.ProcessEnv): boolean {
  const allowed = codexAllowedRepos(env);
  return Boolean(repoId) && !allowed.includes('*') && allowed.includes(repoId!.toLowerCase());
}

export function resolveCodexTimeouts(env?: NodeJS.ProcessEnv): {
  hardMs: number;
  inactivityMs: number;
} {
  const runtime = loadReviewRuntimeConfig(env);
  return { hardMs: runtime.codexTimeoutMs, inactivityMs: runtime.codexInactivityTimeoutMs };
}

export function resolveCodexRateLimitPolicy(
  env?: NodeJS.ProcessEnv,
  injected?: { maxAttempts?: number; maxWaitMs?: number; totalWaitBudgetMs?: number },
): { maxAttempts: number; maxWaitMs: number; totalWaitBudgetMs: number } {
  const runtime = loadReviewRuntimeConfig(env);
  return {
    maxAttempts: Math.min(
      2,
      Math.max(1, Math.floor(injected?.maxAttempts ?? runtime.rateLimitMaxRetries)),
    ),
    maxWaitMs: Math.min(
      60_000,
      Math.max(1_000, injected?.maxWaitMs ?? runtime.codexRateLimitMaxWaitMs),
    ),
    totalWaitBudgetMs: Math.min(
      60_000,
      Math.max(5_000, injected?.totalWaitBudgetMs ?? runtime.codexRateLimitTotalWaitMs),
    ),
  };
}

export function normalizeCodexAttemptError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted && !(error instanceof ReviewCancelledError))
    return new ReviewCancelledError('codex-cli review cancelled');
  return error instanceof Error ? error : new Error(String(error));
}

export function isCodexAuthError(message: string): boolean {
  return /refresh token was revoked|could not be refreshed|log ?out and sign|not (?:logged|signed) in|401|unauthorized|authentication/i.test(
    message,
  );
}

export async function waitForCodexRetry(
  ms: number,
  signal?: AbortSignal,
  clock: Clock = systemClock,
): Promise<void> {
  if (signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clock.clearTimeout(timer);
      reject(new ReviewCancelledError('codex-cli review cancelled'));
    };
    timer = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const moduleRequire = createRequire(import.meta.url);
export function resolveCodexBinary(
  _configuredPath: string | undefined = loadReviewRuntimeConfig().codexCliPath,
  resolvePackage: (specifier: string) => string = (specifier) => moduleRequire.resolve(specifier),
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  try {
    const pinned = resolvePackage('@openai/codex/bin/codex.js');
    if (exists(pinned)) return pinned;
  } catch {
    /* fail closed below */
  }
  throw new Error(
    'pinned Codex CLI package @openai/codex is missing; refusing unpinned fallback binary',
  );
}

const AUTH_MODE_CACHE_TTL_MS = 60_000;
const authModeCache = new Map<string, { mode: CodexAuthMode; expiresAt: number }>();
export function detectCodexAuthMode(codexHome?: string): CodexAuthMode {
  const home = (codexHome && codexHome.trim()) || path.join(os.homedir(), '.codex');
  const cached = authModeCache.get(home);
  if (cached && cached.expiresAt > Date.now()) return cached.mode;
  let mode: CodexAuthMode = 'unknown';
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const declared = typeof parsed.auth_mode === 'string' ? parsed.auth_mode.toLowerCase() : '';
    if (
      declared === 'apikey' ||
      (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0)
    )
      mode = 'apikey';
    else if (
      declared === 'chatgpt' ||
      declared === 'oauth' ||
      declared === 'device_code' ||
      parsed.tokens ||
      parsed.refresh_token ||
      parsed.access_token
    )
      mode = 'oauth';
  } catch {
    /* unavailable homes fail closed */
  }
  authModeCache.set(home, { mode, expiresAt: Date.now() + AUTH_MODE_CACHE_TTL_MS });
  return mode;
}
export function clearCodexAuthModeCache(): void {
  authModeCache.clear();
}

/** The process receives only a minimal environment; the container is the production boundary. */
export function codexChildEnvironment(codexHome?: string, homeIdx?: number): NodeJS.ProcessEnv {
  const runtime = loadReviewRuntimeConfig();
  const env: NodeJS.ProcessEnv = { ...runtime.childProcessEnvironment };
  if (codexHome) env.CODEX_HOME = codexHome;
  const proxy = (homeIdx !== undefined && runtime.codexProxies[homeIdx]) || runtime.codexProxy;
  if (proxy) env.HTTPS_PROXY = env.HTTP_PROXY = env.ALL_PROXY = proxy;
  return env;
}

export function currentEnv(): NodeJS.ProcessEnv {
  return currentEnvironment();
}
