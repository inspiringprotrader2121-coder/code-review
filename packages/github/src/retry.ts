/** Extract Retry-After (seconds or HTTP-date) or common GitHub rate-limit phrasing. */
export function parseGitHubRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: { headers?: Record<string, string> } }).response;
  const header =
    response?.headers?.['retry-after'] ??
    response?.headers?.['Retry-After'] ??
    (error as { headers?: Record<string, string> }).headers?.['retry-after'];
  if (header) {
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.ceil(asSeconds * 1000);
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  }
  const message = (error as { message?: string }).message ?? String(error);
  const retryAfter = /retry[-\s]?after[:\s]+([\d.]+)\s*(?:s(?:ec(?:onds?)?)?)?\b/i.exec(message);
  if (retryAfter) return Math.ceil(parseFloat(retryAfter[1]) * 1000);
  const seconds = /try again in\s*([\d.]+)\s*s(?:ec(?:onds?)?)?\b/i.exec(message);
  if (seconds) return Math.ceil(parseFloat(seconds[1]) * 1000);
  return undefined;
}

export function isGitHubRateLimitError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 403 || status === 429) {
    const message = ((error as { message?: string }).message ?? String(error)).toLowerCase();
    if (
      /rate.?limit|secondary rate|abuse.?detection|retry.?after|exceeded a secondary/i.test(message)
    ) {
      return true;
    }
    // GitHub often returns bare 403 with Retry-After on secondary limits.
    if (parseGitHubRetryAfterMs(error) !== undefined) return true;
    if (status === 429) return true;
  }
  return /rate.?limit|secondary rate|abuse.?detection/i.test(
    (error as { message?: string })?.message ?? String(error),
  );
}

export interface GitHubRetryOptions {
  maxAttempts?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  onRetry?: (waitMs: number, attempt: number, error: unknown) => void;
}

/**
 * Retry-After-aware backoff for compare / content / publish paths that can
 * still surface 403/429 even with Octokit throttling enabled.
 */
export async function withGitHubRetry<T>(
  fn: () => Promise<T>,
  options: GitHubRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.min(5, Math.max(1, Math.floor(options.maxAttempts ?? 3)));
  const maxWaitMs = Math.min(300_000, Math.max(1_000, Math.floor(options.maxWaitMs ?? 60_000)));
  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    if (options.signal?.aborted) throw new Error('github request cancelled');
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempt++;
      if (attempt >= maxAttempts || !isGitHubRateLimitError(error)) throw error;
      const advertised = parseGitHubRetryAfterMs(error);
      const waitMs = Math.min(
        advertised ?? Math.min(1_000 * 2 ** (attempt - 1), maxWaitMs),
        maxWaitMs,
      );
      options.onRetry?.(waitMs, attempt, error);
      await sleep(waitMs, options.signal);
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('github request cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
