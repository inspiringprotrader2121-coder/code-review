type RateBucket = {
  count: number;
  resetAt: number;
};

export type RateLimitOptions = {
  windowMs: number;
  max: number;
};

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

const buckets = new Map<string, RateBucket>();
const MAX_BUCKETS = 100_000;

/**
 * In-memory limiter — fine for low-stakes, single-process niceties
 * (repos-sync). NOT used for authentication or checkout/buy: with >1 server
 * process it multiplies an attacker's budget by the replica count, and the
 * 100k eviction lets a flood of distinct keys evict legit locked accounts.
 * Auth and billing use the DB-backed checkAuthRateLimit below, which is
 * transactional and cross-process.
 */
export function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
  now = Date.now(),
): RateLimitResult {
  pruneExpired(now);
  const windowMs =
    Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? Math.min(Math.floor(opts.windowMs), 7 * 24 * 3600_000)
      : 60_000;
  const max =
    Number.isFinite(opts.max) && opts.max >= 0 ? Math.min(Math.floor(opts.max), 1_000_000) : 1;

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    evictIfOverCapacity();
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function evictIfOverCapacity(): void {
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    buckets.delete(oldest);
  }
}

// ——— DB-backed limiter for authentication surfaces (login / register / MFA /
// account-security). Backed by the same `auth_rate_limits` table + transaction
// as consumeAuthAttempt, so the budget is enforced once across every server
// process and worker — not once per replica. ———

type AuthAttemptStore = {
  consumeAuthAttempt(
    rateKey: string,
    opts: { windowMs: number; max: number },
  ): { allowed: boolean; retryAfterSeconds: number };
  clearAuthAttempts(rateKey: string): void;
};

export function checkAuthRateLimit(
  db: AuthAttemptStore,
  key: string,
  opts: RateLimitOptions,
): RateLimitResult {
  const windowMs =
    Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? Math.min(Math.floor(opts.windowMs), 7 * 24 * 3600_000)
      : 60_000;
  const max =
    Number.isFinite(opts.max) && opts.max >= 0 ? Math.min(Math.floor(opts.max), 1_000_000) : 1;
  return db.consumeAuthAttempt(key, { windowMs, max });
}

export function clearAuthRateLimit(db: AuthAttemptStore, key: string): void {
  db.clearAuthAttempts(key);
}
