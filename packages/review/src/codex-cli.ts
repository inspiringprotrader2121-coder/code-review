import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { buildUserPrompt, loadOrvexRules, type ReviewPromptContext } from './prompt.js';
import { redactPatch, redactSecrets } from './redact.js';
import {
  extractJsonLoose,
  isOversizedModelRequest,
  isRetryableRateLimit,
  parseRetryAfterMs,
  ReviewCancelledError,
  setProviderCooldown,
  withProviderCallSlot,
  type LlmAttemptEvent,
} from './llm-client.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from './types.js';
import { normalizeLlmResponse } from './llm.js';
import { resolveCodexApiKeyConcurrency } from './runtime-limits.js';

export interface CodexCliReviewOptions {
  /** Existing Codex session id to resume; omit to start a new session. */
  threadId?: string;
  /** Model override (defaults from env). */
  model?: string;
  /** Reasoning effort for models that support it. */
  reasoningEffort?: string;
  /** Cancel only this Codex process when its PR closes or merges. */
  signal?: AbortSignal;
  /** cross-file context: repo tree + imported files */
  context?: ReviewPromptContext;
  /** A repo checkout Codex may explore for call sites and tests.
   *  `repoId` must be on the ORVEX_CODEX_CLI_REPOS allowlist. */
  cwd?: string;
  /** "owner/repo" of the repo being reviewed. Required for `cwd` to be honored
   *  (first-party allowlist enforcement — see isCodexRepoAllowed). */
  repoId?: string;
  /**
   * Prompt budget mode. Default: `lean` when a checkout is present, else `full`.
   * `slim` is used automatically once after a Request-too-large failure.
   */
  promptMode?: CodexPromptMode;
  /** token-usage callback for cost tracking. Without this the agentic pass —
   *  the most expensive one — reported $0 and spend was invisible. */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    model?: string;
    provider?: string;
    attemptId?: string;
  }) => void;
  /** Durable lifecycle callback for each actual Codex child attempt. */
  onAttempt?: (event: LlmAttemptEvent) => void;
}

/** How much context we paste into the Codex CLI turn. */
export type CodexPromptMode = 'full' | 'lean' | 'slim';

/** The production agentic reviewer. Never fall back to a different paid model. */
export const DEFAULT_CODEX_CLI_MODEL = 'gpt-5.6-luna';
export const DEFAULT_CODEX_CLI_REASONING_EFFORT = 'max';

/**
 * FIRST-PARTY REPO ALLOWLIST — defense in depth, INDEPENDENT of the
 * ORVEX_CODEX_CLI feature flag. codex runs with
 * `--dangerously-bypass-approvals-and-sandbox` and shell access inside the repo
 * checkout, i.e. it can execute whatever a malicious PR puts in the repo (build
 * scripts, hooks, "test fixtures"). Diff-only input does not remove shell or
 * network capability, so the complete invocation is limited to repos listed in
 * ORVEX_CODEX_CLI_REPOS (comma-separated "owner/repo", case-insensitive;
 * "*" disables the check — NOT recommended). Unset/empty = no repo is ever
 * reviewed by Codex, no matter what the caller or the feature flag says.
 */
export function codexAllowedRepos(): string[] {
  return (process.env.ORVEX_CODEX_CLI_REPOS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isCodexRepoAllowed(repoId: string | undefined): boolean {
  const allow = codexAllowedRepos();
  if (allow.includes('*')) return true;
  if (!repoId) return false;
  return allow.includes(repoId.toLowerCase());
}

export interface CodexCliReviewResult {
  response: LlmReviewResponse;
  /** The session id for this PR (new or resumed). */
  threadId: string;
}

const CODEX_DELETE_TIMEOUT_MS = 15_000;
const MAX_CODEX_STDOUT_CHARS = 8_000_000;
const MAX_CODEX_STDERR_CHARS = 256_000;

/**
 * Best-effort cleanup of a persisted Codex session when its PR is closed/merged.
 * The session files on disk are passive (no CPU), but deleting them keeps the
 * ~/.codex state from growing forever. Timeouts are defensive in case `codex
 * delete` becomes interactive on future CLI versions.
 */
export async function closeCodexSession(threadRef: string): Promise<void> {
  const { homeIdx, threadId } = decodeThreadRef(threadRef);
  if (!threadId) return;
  return new Promise((resolve) => {
    const child = spawn(codexBinary(), ['delete', threadId, '--json'], {
      env: shellEnv(CODEX_HOME_POOL[homeIdx ?? 0], homeIdx ?? 0),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      console.warn(`[codex-cli] delete ${threadId} timed out, killing`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, CODEX_DELETE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Parse a numeric env var, falling back when unset/non-numeric. A bare
 *  `Number(x)` yields NaN for a typo'd value, and NaN silently defeats every
 *  comparison it touches (`i >= NaN` is always false → infinite retry loop). */
function finiteEnv(raw: string | undefined, fallback: number): number {
  // Treat empty/whitespace as UNSET: `Number('')` is 0 (finite!), so a bare
  // `FOO=` in .env would otherwise become a real zero rather than the default.
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function waitForCodexRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ReviewCancelledError('codex-cli review cancelled'));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ReviewCancelledError('codex-cli review cancelled'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Detect a Codex CLI diagnostic that announces a model substitution. The CLI
 * has historically accepted an unsupported requested model and silently moved
 * to a costlier one; Orvex must fail closed instead of paying for that run.
 */
export function codexAnnouncedModelFallback(output: string): boolean {
  const compact = output.replace(/\s+/g, ' ');
  return (
    /(?:model\s+)?[\w.-]+\s+(?:is\s+)?not supported.{0,160}\bfalling back to\b/i.test(compact)
    || /\bfalling back to\s+(?:model\s+)?(?:gpt-|codex-|o[1-9](?:\b|-))/i.test(compact)
  );
}

export function resolveCodexTimeouts(env: NodeJS.ProcessEnv = process.env): {
  hardMs: number;
  inactivityMs: number;
} {
  const hardMs = Math.min(
    300_000,
    Math.max(60_000, finiteEnv(env.ORVEX_CODEX_TIMEOUT_MS, 300_000)),
  );
  const inactivityMs = Math.min(
    hardMs,
    Math.max(30_000, finiteEnv(env.ORVEX_CODEX_INACTIVITY_TIMEOUT_MS, 180_000)),
  );
  return { hardMs, inactivityMs };
}

export function resolveCodexRateLimitPolicy(env: NodeJS.ProcessEnv = process.env): {
  maxAttempts: number;
  maxWaitMs: number;
  totalWaitBudgetMs: number;
} {
  // At most one retry, and at most one minute waiting in total. A rate-limited
  // agentic run may already have consumed tokens before the CLI exits; allowing
  // four full restarts created both tail-latency spikes and surprise spend.
  const maxAttempts = Math.min(
    2,
    Math.max(1, Math.floor(finiteEnv(env.ORVEX_RATELIMIT_MAX_RETRIES, 2))),
  );
  const maxWaitMs = Math.min(
    60_000,
    Math.max(1_000, finiteEnv(env.ORVEX_CODEX_RATELIMIT_MAX_WAIT_MS, 60_000)),
  );
  const totalWaitBudgetMs = Math.min(
    60_000,
    Math.max(5_000, finiteEnv(env.ORVEX_CODEX_RATELIMIT_TOTAL_WAIT_MS, 60_000)),
  );
  return { maxAttempts, maxWaitMs, totalWaitBudgetMs };
}

export function normalizeCodexAttemptError(
  error: unknown,
  signal?: AbortSignal,
): Error {
  if (signal?.aborted && !(error instanceof ReviewCancelledError)) {
    return new ReviewCancelledError('codex-cli review cancelled');
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Live codex children, so a worker shutdown can kill them. `detached: true`
 *  puts each child in its own process group (needed to kill grandchildren on
 *  timeout) but that ALSO means it survives the parent — every deploy would
 *  otherwise orphan an unsandboxed agent still running against a PR checkout. */
const liveCodexChildren = new Set<number>();

/**
 * Optional hooks so the worker can attribute Codex PIDs to the in-flight review
 * that spawned them (super-admin live resource monitor). Failures in listeners
 * must never break a review.
 */
export type CodexChildListener = {
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
};
let codexChildListener: CodexChildListener = {};
export function setCodexChildListener(listener: CodexChildListener): void {
  codexChildListener = listener;
}

/** Kill every in-flight codex process group. Called from the worker's shutdown
 *  path so a deploy doesn't leave agents running. */
export function killAllCodexChildren(): number {
  let killed = 0;
  for (const pid of liveCodexChildren) {
    try {
      process.kill(-pid, 'SIGKILL');
      killed++;
    } catch {
      /* already gone */
    }
  }
  liveCodexChildren.clear();
  return killed;
}

const moduleRequire = createRequire(import.meta.url);

export function resolveCodexBinary(
  _configuredPath = process.env.ORVEX_CODEX_CLI_PATH,
  resolvePackage: (specifier: string) => string = (specifier) => moduleRequire.resolve(specifier),
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  // Resolve the executable from this package's exact dependency graph. This is
  // independent of process.cwd() (production starts in apps/server) and cannot
  // drift to PATH or an operator-configured global binary.
  try {
    const pinned = resolvePackage('@openai/codex/bin/codex.js');
    if (exists(pinned)) return pinned;
  } catch {
    // Fall through to the same fail-closed error without exposing resolver data.
  }
  throw new Error('pinned Codex CLI package @openai/codex is missing; refusing unpinned fallback binary');
}

function codexBinary(): string {
  return resolveCodexBinary();
}

function shellEnv(codexHome?: string, homeIdx?: number): NodeJS.ProcessEnv {
  // MINIMAL, ALLOWLISTED env — NOT `{ ...process.env }`. codex runs untrusted PR
  // code as an agent with shell access; inheriting the full server env would hand
  // it every secret (Stripe key, GitHub App private key, all LLM keys, DB path).
  // codex authenticates via CODEX_HOME (below), not env, so no keys are needed
  // here. Only pass PATH, locale/cert basics, and the vars we explicitly set.
  const ALLOWED_ENV = [
    'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ];
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  for (const k of ALLOWED_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  // ISOLATE the reviewer's OAuth: use a DEDICATED CODEX_HOME so interactive codex
  // sessions / other agents on the same box can't rotate & revoke the server's
  // refresh token. Login once per home with this same CODEX_HOME set.
  if (codexHome) env.CODEX_HOME = codexHome;
  // RESIDENTIAL/ISP PROXY per account: OpenAI revokes ChatGPT sessions whose
  // traffic pattern looks suspicious (a datacenter IP is the classic trigger —
  // the recurring token_invalidated incidents). Route each account's codex
  // traffic through a STABLE ISP proxy so its sessions live on one residential
  // identity, like a laptop at home. Config:
  //   ORVEX_CODEX_PROXIES=http://user:pass@ip1:port,http://user:pass@ip2:port
  //     (aligned index-for-index with ORVEX_CODEX_HOMES — one sticky IP per account)
  //   ORVEX_CODEX_PROXY=http://user:pass@ip:port   (single-account setups)
  // IMPORTANT: the one-time `codex login` for each home must ALSO run with these
  // env vars set, so the session is BORN on its proxy IP.
  const proxies = (process.env.ORVEX_CODEX_PROXIES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const proxy = (homeIdx !== undefined && proxies[homeIdx]) || process.env.ORVEX_CODEX_PROXY;
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.ALL_PROXY = proxy;
  }
  return env;
}

export type CodexAuthMode = 'apikey' | 'oauth' | 'unknown';

/**
 * Counting semaphore: up to `limit` callers run `fn` concurrently; the rest wait.
 * Used so API-key Codex homes can run multiple CLI processes at once.
 */
export class CountingSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get concurrency(): number {
    return this.limit;
  }

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new ReviewCancelledError('codex-cli review cancelled'));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort!);
          reject(new ReviewCancelledError('codex-cli review cancelled'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    for (;;) {
      const next = this.waiters.shift();
      if (!next) return;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      if (next.signal?.aborted) {
        next.reject(new ReviewCancelledError('codex-cli review cancelled'));
        continue;
      }
      this.active++;
      next.resolve();
      return;
    }
  }
}

/**
 * Resolve how many Codex CLI processes may share one API-key CODEX_HOME.
 * OAuth callers must pass mode !== 'apikey' and always get 1.
 */
export function resolveCodexHomeConcurrency(
  mode: CodexAuthMode,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (mode !== 'apikey') return 1;
  return resolveCodexApiKeyConcurrency(env);
}

/**
 * CODEX ACCOUNT POOL — load-balance across MULTIPLE Codex homes.
 *
 * Config: ORVEX_CODEX_HOMES=/home/x/.codex-orvex,/home/x/.codex-orvex2 (one
 * CODEX_HOME dir per account). Falls back to the single ORVEX_CODEX_HOME.
 *
 * Concurrency rules:
 * - **OAuth / ChatGPT homes stay SERIAL (1)** — concurrent refreshes of one
 *   auth.json race and revoke each other. Scale OAuth by adding more homes.
 * - **API-key homes use ORVEX_CODEX_APIKEY_CONCURRENCY** (default 8). They do
 *   not share OAuth refresh state, so independent sessions may run in parallel.
 * - A PR's session sticks to the home that created it (rollouts live in that
 *   home); the stored thread ref encodes the home as "hN:<threadId>".
 * - A home whose auth fails is benched for 15 minutes and the call fails
 *   over to the next healthy home with a fresh session.
 */
const CODEX_HOME_POOL: (string | undefined)[] = (() => {
  const multi = process.env.ORVEX_CODEX_HOMES;
  if (multi) {
    const homes = multi.split(',').map((s) => s.trim()).filter(Boolean);
    if (homes.length > 0) return homes;
  }
  return [process.env.ORVEX_CODEX_HOME]; // may be [undefined] → shared ~/.codex
})();
const homeBusy: number[] = CODEX_HOME_POOL.map(() => 0);
const homeDeadUntil: number[] = CODEX_HOME_POOL.map(() => 0);
const homeSlots: CountingSemaphore[] = CODEX_HOME_POOL.map(() => new CountingSemaphore(1));
const homeSlotLimitLogged = new Set<number>();
const CODEX_HOME_BENCH_MS = 15 * 60_000;
const AUTH_MODE_CACHE_TTL_MS = 60_000;
const authModeCache = new Map<string, { mode: CodexAuthMode; expiresAt: number }>();
const codexUsageTotals = new Map<string, { input: number; output: number; reasoning: number }>();
const MAX_CODEX_USAGE_TOTALS = 10_000;

type CodexHomeLock = <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** Test-only override for exercising the production home admission path without
 * mutating a real CODEX_HOME/auth.json file or launching a Codex child. */
let homeLockTestOverride: { mode: CodexAuthMode; env: NodeJS.ProcessEnv } | undefined;

// With API-key concurrency, two calls can RESUME the same persisted thread in
// parallel on one home. Codex then reports each one's CUMULATIVE thread usage,
// and both deltas would be computed against the same stale baseline — the
// tokens burned between them are attributed to both (double-counted COGS).
// Serialize resumes per thread so the baseline read→write below stays
// monotonic. New sessions (threadId undefined) are independent and unchained.
const codexResumeChains = new Map<string, Promise<unknown>>();

/**
 * Read CODEX_HOME/auth.json auth_mode without exposing secrets.
 * `apikey` → parallel CLI safe; anything else → serialize (OAuth refresh race).
 */
export function detectCodexAuthMode(codexHome?: string): CodexAuthMode {
  const dir = (codexHome && codexHome.trim()) || path.join(os.homedir(), '.codex');
  const cached = authModeCache.get(dir);
  if (cached && cached.expiresAt > Date.now()) return cached.mode;

  let mode: CodexAuthMode = 'unknown';
  try {
    const raw = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const authMode = typeof parsed.auth_mode === 'string' ? parsed.auth_mode.toLowerCase() : '';
    if (authMode === 'apikey') mode = 'apikey';
    else if (authMode === 'chatgpt' || authMode === 'oauth' || authMode === 'device_code') mode = 'oauth';
    else if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0) mode = 'apikey';
    else if (parsed.tokens || parsed.refresh_token || parsed.access_token) mode = 'oauth';
  } catch {
    mode = 'unknown';
  }
  authModeCache.set(dir, { mode, expiresAt: Date.now() + AUTH_MODE_CACHE_TTL_MS });
  return mode;
}

/** Fail before any sibling model call can spend money when the required Luna
 * runtime is unavailable. */
export function assertCodexRuntimeReady(
  homes: readonly (string | undefined)[] = CODEX_HOME_POOL,
): string {
  const binary = resolveCodexBinary();
  if (!homes.some((home) => detectCodexAuthMode(home) === 'apikey')) {
    throw new Error('codex-cli Luna requires at least one API-key-authenticated Codex home');
  }
  return binary;
}

/** Clear auth-mode cache (tests). */
export function clearCodexAuthModeCache(): void {
  authModeCache.clear();
}

function homeLabel(idx: number): string {
  return CODEX_HOME_POOL[idx] ?? '~/.codex';
}

function ensureHomeSlot(idx: number): CountingSemaphore {
  const override = homeLockTestOverride;
  const mode = override?.mode ?? detectCodexAuthMode(CODEX_HOME_POOL[idx]);
  const limit = resolveCodexHomeConcurrency(mode, override?.env ?? process.env);
  const existing = homeSlots[idx];
  if (!existing || existing.concurrency !== limit) {
    // Recreate only when idle; if in-flight, keep the old gate for those waiters
    // and install a new one for future acquires once the limit changes mid-process
    // (rare — env usually fixed at boot). Prefer stable gate if busy.
    if (!existing || existing.inFlight === 0) {
      homeSlots[idx] = new CountingSemaphore(limit);
    }
  }
  if (!homeSlotLimitLogged.has(idx)) {
    homeSlotLimitLogged.add(idx);
    console.log(
      `[codex-cli] home ${idx + 1}/${CODEX_HOME_POOL.length} (${homeLabel(idx)}) ` +
        `auth=${mode} concurrency=${homeSlots[idx]!.concurrency}`,
    );
  }
  return homeSlots[idx]!;
}

/** Prefer the session's own home (affinity); otherwise the least-busy healthy home. */
function pickHome(preferred?: number): number {
  const now = Date.now();
  // Session affinity wins over balance: resuming a thread REQUIRES its own home.
  if (
    preferred !== undefined
    && preferred < CODEX_HOME_POOL.length
    && homeDeadUntil[preferred] <= now
    && detectCodexAuthMode(CODEX_HOME_POOL[preferred]) === 'apikey'
  ) {
    return preferred;
  }
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < CODEX_HOME_POOL.length; i++) {
    const dead = homeDeadUntil[i] > now || detectCodexAuthMode(CODEX_HOME_POOL[i]) !== 'apikey';
    const score = (dead ? 1000 : 0) + homeBusy[i];
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Acquire a Codex home slot then run `fn`.
 * API-key homes: up to N concurrent. OAuth/unknown: serial (N=1).
 */
function withHomeLock<T>(idx: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const gate = ensureHomeSlot(idx);
  homeBusy[idx]++;
  return gate
    .run(fn, signal)
    .finally(() => {
      homeBusy[idx]--;
    });
}

/** Exercise the same home-lock admission used in production with a synthetic
 * auth mode and environment. It is intentionally limited to tests: no Codex
 * process, binary, prompt, timeout, or runtime configuration is overridden. */
export async function withCodexHomeLockForTest<T>(
  options: { mode: CodexAuthMode; env?: NodeJS.ProcessEnv },
  test: (withLock: CodexHomeLock) => Promise<T>,
): Promise<T> {
  const previousOverride = homeLockTestOverride;
  const previousSlot = homeSlots[0]!;
  const previousBusy = homeBusy[0]!;
  const wasLogged = homeSlotLimitLogged.has(0);
  homeLockTestOverride = { mode: options.mode, env: options.env ?? process.env };
  homeSlots[0] = new CountingSemaphore(1);
  homeBusy[0] = 0;
  homeSlotLimitLogged.delete(0);
  try {
    return await test((run, signal) => withHomeLock(0, run, signal));
  } finally {
    homeLockTestOverride = previousOverride;
    homeSlots[0] = previousSlot;
    homeBusy[0] = previousBusy;
    if (wasLogged) homeSlotLimitLogged.add(0);
    else homeSlotLimitLogged.delete(0);
  }
}

/** Stored thread refs encode their home as "hN:<threadId>" (multi-home only). */
function decodeThreadRef(ref?: string): { homeIdx?: number; threadId?: string } {
  if (!ref) return {};
  const m = /^h(\d+):(.+)$/.exec(ref);
  if (m) {
    const idx = Number(m[1]);
    return idx < CODEX_HOME_POOL.length ? { homeIdx: idx, threadId: m[2] } : {}; // pool shrank — start fresh
  }
  return { homeIdx: 0, threadId: ref }; // legacy un-prefixed ref
}

function encodeThreadRef(homeIdx: number, threadId: string): string {
  return CODEX_HOME_POOL.length > 1 ? `h${homeIdx}:${threadId}` : threadId;
}

/** Codex OAuth failure (revoked/expired token) — distinct from a normal review
 *  error so the pipeline can alert loudly instead of silently degrading. */
export function isCodexAuthError(message: string): boolean {
  return /refresh token was revoked|could not be refreshed|log ?out and sign|not (?:logged|signed) in|401|unauthorized|authentication/i.test(
    message,
  );
}

function envCharBudget(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Cap pasted diffs so the Codex opening turn stays under Luna's request size.
 * Remaining files keep a stub pointing the agent at the on-disk checkout.
 */
export function capCodexDiffFiles<T extends { filename: string; status: string; patch?: string }>(
  files: readonly T[],
  maxChars: number,
): T[] {
  if (maxChars <= 0) {
    return files.map((f) => ({
      ...f,
      patch: `(diff omitted — read ${f.filename} from the checkout)`,
    }));
  }
  let used = 0;
  const out: T[] = [];
  for (const f of files) {
    const patch = f.patch ?? '';
    if (used >= maxChars) {
      out.push({
        ...f,
        patch: `(diff omitted — Codex prompt budget; read ${f.filename} from the checkout)`,
      });
      continue;
    }
    const room = maxChars - used;
    if (patch.length <= room) {
      out.push(f);
      used += patch.length;
    } else {
      out.push({
        ...f,
        patch:
          patch.slice(0, Math.max(0, room - 80)) +
          `\n… [truncated ${patch.length - room} chars — read full file from checkout]`,
      });
      used = maxChars;
    }
  }
  return out;
}

const LEAN_EXPLORE = [
  '## You are an agent — INVESTIGATE the repo, do not one-shot',
  'The complete repository is checked out at your CWD. Diffs below are a STARTING',
  'POINT only — source bodies were NOT pasted (read them from disk).',
  'Before you report:',
  '- `rg`/`grep` changed symbols for callers/callees and broken invariants.',
  '- Read changed files with `sed -n` / `head` ranges — NEVER dump a whole large file',
  '  into the conversation (that blows the context window and fails the review).',
  '- Trace data flow and nearby tests; confirm every finding at file:line.',
  'Return JSON: { "findings": [...], "summary": "..." }.',
  '',
].join('\n');

const SLIM_EXPLORE = [
  '## Agentic review (slim context — prior turn was too large)',
  'Repo is at CWD. Use `rg` and `sed -n` only; do NOT cat whole files.',
  'Focus on concrete P1/P2 bugs in the changed paths below.',
  'Return JSON: { "findings": [...], "summary": "..." }.',
  '',
].join('\n');

/**
 * Build the Codex CLI user/system prompt.
 *
 * With a checkout, default mode is `lean`: omit pasted changedContents (agent
 * reads from disk), cap diffs/tree, and keep a hard prompt ceiling so the
 * opening turn + tool loop can still compact under Luna's request limit.
 */
export function buildCodexPrompt(
  files: ReviewableFile[],
  context?: ReviewPromptContext,
  opts: { hasRepoCheckout?: boolean; mode?: CodexPromptMode } = {},
): string {
  const hasCheckout = Boolean(opts.hasRepoCheckout);
  const mode: CodexPromptMode = opts.mode ?? (hasCheckout ? 'lean' : 'full');
  const reviewable = files.filter((f) => f.patch && f.status !== 'removed');
  const maxDiffChars =
    mode === 'slim'
      ? envCharBudget('ORVEX_CODEX_SLIM_DIFF_CHARS', 30_000)
      : mode === 'lean'
        ? envCharBudget('ORVEX_CODEX_MAX_DIFF_CHARS', 60_000)
        : Number.POSITIVE_INFINITY;
  const redactedFiles = capCodexDiffFiles(
    reviewable.map((f) => ({
      filename: f.filename,
      status: f.status,
      patch: redactPatch(f.patch),
    })),
    Number.isFinite(maxDiffChars) ? maxDiffChars : 10_000_000,
  );

  const redactAll = (files?: Array<{ path: string; content: string }>) =>
    files?.map((f) => ({ ...f, content: redactSecrets(f.content) }));

  const maxTree =
    mode === 'slim' ? 0 : mode === 'lean' ? envCharBudget('ORVEX_CODEX_MAX_TREE_PATHS', 400) : undefined;

  // full: paste retrieval context. lean/slim with checkout: never paste
  // changedContents / related / others — agent reads from disk.
  const ctx: ReviewPromptContext | undefined = context
    ? {
        treePaths:
          maxTree === 0
            ? undefined
            : maxTree !== undefined
              ? context.treePaths?.slice(0, maxTree)
              : context.treePaths,
        related: hasCheckout || mode !== 'full' ? undefined : redactAll(context.related),
        dependents: hasCheckout || mode !== 'full' ? undefined : redactAll(context.dependents),
        changedContents:
          hasCheckout || mode === 'lean' || mode === 'slim'
            ? undefined
            : redactAll(context.changedContents),
        others: hasCheckout || mode !== 'full' ? undefined : redactAll(context.others),
        extraFocus: context.extraFocus,
      }
    : undefined;

  const user = buildUserPrompt(redactedFiles, ctx);
  if (mode === 'slim') {
    const body = `${SLIM_EXPLORE}\n${user}`;
    return trimCodexPrompt(body, envCharBudget('ORVEX_CODEX_SLIM_PROMPT_CHARS', 50_000));
  }

  const system = loadOrvexRules();
  if (!hasCheckout && mode === 'full') {
    return `${system}\n\n${user}`;
  }

  const explore = hasCheckout ? LEAN_EXPLORE : '';
  const combined = explore ? `${system}\n\n${explore}\n${user}` : `${system}\n\n${user}`;
  return trimCodexPrompt(combined, envCharBudget('ORVEX_CODEX_MAX_PROMPT_CHARS', 100_000));
}

/** Hard ceiling: drop from the end (usually tree/context) with a clear marker. */
export function trimCodexPrompt(prompt: string, maxChars: number): string {
  if (maxChars <= 0 || prompt.length <= maxChars) return prompt;
  const keep = Math.max(0, maxChars - 120);
  return (
    prompt.slice(0, keep) +
    `\n\n… [Codex prompt truncated ${prompt.length - keep} chars to stay under request size — explore the checkout for omitted context]\n`
  );
}

async function runCodexExec(
  prompt: string,
  opts: {
    model: string;
    reasoningEffort?: string;
    threadId?: string;
    /** repo checkout dir codex may read (read-only sweep); defaults to an empty tmp dir */
    cwd?: string;
    /** CODEX_HOME dir of the account this call runs on (from the pool) */
    home?: string;
    /** pool index of the account (selects its sticky ISP proxy) */
    homeIdx?: number;
    /** token-usage callback for cost tracking */
    onUsage?: (usage: {
      inputTokens: number;
      outputTokens: number;
      tokenSource?: 'provider' | 'estimate';
      model?: string;
      provider?: string;
      attemptId?: string;
    }) => void;
    onAttempt?: (event: LlmAttemptEvent) => void;
    attemptState?: { lastAttemptId?: string; nextRetryIndex: number };
    /** Internal process-lifecycle test seam; production never supplies these. */
    binaryPath?: string;
    testTimeouts?: { hardMs: number; inactivityMs: number };
    testEnv?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<{ text: string; threadId: string }> {
  if (opts.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
  const homeIdx = opts.homeIdx ?? 0;
  const execute = () => {
    const attemptId = randomUUID();
    const started = Date.now();
    const retryIndex = opts.attemptState?.nextRetryIndex ?? 0;
    const parentAttemptId = opts.attemptState?.lastAttemptId;
    if (opts.attemptState) {
      opts.attemptState.lastAttemptId = attemptId;
      opts.attemptState.nextRetryIndex += 1;
    }
    opts.onAttempt?.({
      phase: 'started',
      attemptId,
      parentAttemptId,
      retryIndex,
      keyIndex: homeIdx,
      provider: 'codex-cli',
      model: opts.model,
      transport: 'codex-cli',
      startedAt: new Date(started).toISOString(),
    });
    return withProviderCallSlot(
      'luna',
      () => runCodexExecInner(prompt, {
        ...opts,
        onUsage: opts.onUsage
          ? (usage) => opts.onUsage?.({ ...usage, attemptId })
          : undefined,
      }),
      opts.signal,
    ).then(
      (result) => {
        opts.onAttempt?.({
          phase: 'finished',
          attemptId,
          outcome: 'succeeded',
          durationMs: Date.now() - started,
          completedAt: new Date().toISOString(),
        });
        return result;
      },
      (error) => {
        const normalized = normalizeCodexAttemptError(error, opts.signal);
        const message = normalized.message;
        const outcome = normalized instanceof ReviewCancelledError
          ? 'cancelled'
          : /wall-clock cap|timed?\s*out|produced no output/i.test(message)
            ? 'timed_out'
            : isRetryableRateLimit(message)
              ? 'rate_limited'
              : 'failed';
        opts.onAttempt?.({
          phase: 'finished',
          attemptId,
          outcome,
          durationMs: Date.now() - started,
          completedAt: new Date().toISOString(),
          error: message.slice(0, 2_000),
        });
        throw normalized;
      },
    );
  };
  // Serialize concurrent resumes of the SAME thread OUTSIDE the home lock so
  // waiters do not consume CountingSemaphore slots while queued on the chain.
  // The home lock is acquired only for the actual exec.
  if (opts.threadId) {
    const key = `${homeIdx}:${opts.threadId}:${opts.model}`;
    const prior = codexResumeChains.get(key) ?? Promise.resolve();
    const run = prior.then(() => {
      if (opts.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
      return withHomeLock(homeIdx, execute, opts.signal);
    });
    // Store a settled-proof handle as the chain link so one rejection doesn't
    // poison the next resume.
    const link = run.catch(() => {});
    codexResumeChains.set(key, link);
    try {
      return await run;
    } finally {
      // Only delete when this link is still the chain tail — a later resume may
      // have already extended the chain past us.
      if (codexResumeChains.get(key) === link) codexResumeChains.delete(key);
    }
  }
  return withHomeLock(homeIdx, execute, opts.signal);
}

async function runCodexExecInner(
  prompt: string,
  opts: {
    model: string;
    reasoningEffort?: string;
    threadId?: string;
    cwd?: string;
    home?: string;
    homeIdx?: number;
    onUsage?: (usage: {
      inputTokens: number;
      outputTokens: number;
      tokenSource?: 'provider' | 'estimate';
      model?: string;
      provider?: string;
      attemptId?: string;
    }) => void;
    binaryPath?: string;
    testTimeouts?: { hardMs: number; inactivityMs: number };
    testEnv?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<{ text: string; threadId: string }> {
  if (opts.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-codex-'));
  const lastMsgFile = path.join(tmpDir, 'last-message.txt');

  const args = ['exec'];
  args.push(
    '--model',
    opts.model,
    '--json',
    // Bypass codex's own sandbox: its bwrap read-only mode FAILS to initialize on
    // this host (bwrap loopback/netns error), which blocks codex from running the
    // shell commands it uses to AGENTICALLY explore the repo — degrading it to a
    // shallow one-shot review. The server is a dedicated VM (externally sandboxed),
    // which is exactly what this flag is intended for. See prompt note re: untrusted
    // PR content — the anti-injection guard in buildUserPrompt is the mitigation.
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--output-last-message',
    lastMsgFile,
  );
  // --cd is only valid when starting a brand-new session; resume ignores it. Use
  // the repo checkout when provided so codex can agentically sweep the whole repo.
  if (!opts.threadId) {
    args.push('--cd', opts.cwd ?? tmpDir);
  }
  if (opts.reasoningEffort) {
    // CORRECT codex config key is `model_reasoning_effort`; the old
    // `reasoning_effort` was silently ignored → codex ran at default (low) effort.
    args.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
  }
  if (opts.threadId) {
    args.push('resume', opts.threadId);
  }
  args.push('-');

  return new Promise((resolve, reject) => {
    const child = spawn(opts.binaryPath ?? codexBinary(), args, {
      env: opts.testEnv ?? shellEnv(opts.home, opts.homeIdx),
      cwd: tmpDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so the timeout below can kill codex AND any
      // grandchildren it spawned (it runs with the sandbox bypassed). Without
      // this, `process.kill(-pid)` would target our own group.
      detached: true,
    });

    // HARD WALL-CLOCK CAP — the promise MUST settle. `close` fires only once the
    // process has exited AND all stdio pipes are closed, so a single daemonized
    // grandchild holding a pipe (a PR's build script, a background server) would
    // leave this pending FOREVER: the home lock serializes every later codex call
    // behind it, the worker slot is never released, /ready never goes idle, and
    // every future deploy aborts on its idle wait. So we reject on the timer
    // itself rather than trusting `close` to arrive.
    // Cap hung/agentic stalls. Successful Luna calls usually finish in 1–3 min;
    // the old 30m default let dead Cloudflare streams burn a full review slot.
    const { hardMs, inactivityMs } = opts.testTimeouts ?? resolveCodexTimeouts();
    let settled = false;
    let cleaned = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const onCancel = () => {
      killProcessGroup();
      finish(() => {
        cleanup();
        reject(new ReviewCancelledError('codex-cli review cancelled'));
      });
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      opts.signal?.removeEventListener('abort', onCancel);
      fn();
    };
    const killProcessGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL'); // whole group
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const rejectForTimeout = (message: string) => {
      killProcessGroup();
      finish(() => {
        cleanup();
        reject(new Error(message));
      });
    };
    const rejectForModelFallback = () => {
      killProcessGroup();
      finish(() => {
        cleanup();
        reject(new Error(`codex-cli refused model substitution; required model is ${opts.model}`));
      });
    };
    const armInactivityTimer = () => {
      if (settled) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        rejectForTimeout(`codex-cli produced no output for ${inactivityMs}ms`);
      }, inactivityMs);
    };
    killTimer = setTimeout(() => {
      rejectForTimeout(`codex-cli exceeded ${hardMs}ms wall-clock cap`);
    }, hardMs);
    armInactivityTimer();

    if (child.pid !== undefined) {
      liveCodexChildren.add(child.pid);
      try {
        codexChildListener.onSpawn?.(child.pid);
      } catch (err) {
        console.warn('[codex-cli] child spawn listener failed:', (err as Error).message);
      }
    }
    opts.signal?.addEventListener('abort', onCancel, { once: true });
    if (opts.signal?.aborted) {
      onCancel();
      return;
    }

    let stdout = '';
    let stderr = '';
    const appendCapped = (current: string, chunk: string, max: number): string =>
      current.length >= max ? current : (current + chunk).slice(0, max);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      armInactivityTimer();
      stdout = appendCapped(stdout, chunk, MAX_CODEX_STDOUT_CHARS);
      if (codexAnnouncedModelFallback(stdout)) {
        rejectForModelFallback();
      }
    });
    child.stderr.on('data', (chunk) => {
      armInactivityTimer();
      stderr = appendCapped(stderr, chunk, MAX_CODEX_STDERR_CHARS);
      if (codexAnnouncedModelFallback(stderr)) {
        rejectForModelFallback();
      }
    });

    child.stdin.on('error', (err) => {
      // Swallow EPIPE from the child exiting early; the real exit reason is
      // captured via stdout/stderr and surfaced from the 'close' handler.
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.warn('[codex-cli] stdin error:', err.message);
      }
    });
    child.stdin.end(prompt);

    child.on('error', (err) => {
      finish(() => {
        cleanup();
        reject(err);
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      try {
        const threadId = extractThreadId(stdout);
        const text = readLastMessage(lastMsgFile);
        const usage = extractUsage(stdout);
        // Report usage even on the FAILURE path: codex bills for the tokens it
        // burned whether or not it produced a parseable answer, and this is the
        // only place that usage is observable. Dropping it made the most
        // expensive pass report $0 and hid spend exactly when it mattered.
        if (usage) {
          // Codex can report cumulative usage when a persisted thread is
          // resumed. The ledger must contain the delta for this attempt, not
          // the whole thread total. New sessions use the temporary directory
          // as their key so independent calls never subtract one another.
          const usageKey = `${opts.homeIdx ?? 0}:${opts.threadId ?? tmpDir}:${opts.model}`;
          const previous = codexUsageTotals.get(usageKey);
          const delta = {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            reasoning: usage.reasoning ?? 0,
          };
          // The billed counters are cumulative only when BOTH input and output
          // remain monotonic. An OR here would subtract a reset counter when a
          // different field happened to increase, silently under-reporting a
          // resumed call.
          if (previous && delta.input >= previous.input && delta.output >= previous.output) {
            delta.input = Math.max(0, delta.input - previous.input);
            delta.output = Math.max(0, delta.output - previous.output);
            delta.reasoning = delta.reasoning >= previous.reasoning ? delta.reasoning - previous.reasoning : delta.reasoning;
          }
          const totals = {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            reasoning: usage.reasoning ?? 0,
          };
          codexUsageTotals.set(usageKey, totals);
          // Create→resume handoff: seed the thread-id key so the first resume
          // deltas against this create's cumulative baseline instead of billing
          // the whole thread again.
          if (!opts.threadId && threadId) {
            codexUsageTotals.set(`${opts.homeIdx ?? 0}:${threadId}:${opts.model}`, totals);
          }
          while (codexUsageTotals.size > MAX_CODEX_USAGE_TOTALS) {
            const oldest = codexUsageTotals.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            codexUsageTotals.delete(oldest);
          }
          opts.onUsage?.({
            inputTokens: delta.input,
            // Codex output_tokens already represents the billed model output
            // bucket; reasoning_output_tokens is diagnostic, not an additional
            // output amount. Adding both double-counted reasoning in COGS.
            outputTokens: delta.output,
            tokenSource: 'provider',
            model: opts.model,
            provider: 'codex-cli',
          });
          console.warn(
            `[codex-cli] usage: ${delta.input} in / ${delta.reasoning} reasoning / ${delta.output} out tokens`,
          );
        } else {
          // Usage event missing from stdout — still reserve a conservative
          // floor so the COGS safety ceiling cannot treat a real agentic burn
          // as $0 (which previously let Verify pass the cost gate forever).
          const floorIn = Number(process.env.ORVEX_CODEX_USAGE_FLOOR_INPUT ?? 50_000);
          const floorOut = Number(process.env.ORVEX_CODEX_USAGE_FLOOR_OUTPUT ?? 5_000);
          opts.onUsage?.({
            inputTokens: Number.isFinite(floorIn) && floorIn > 0 ? Math.floor(floorIn) : 50_000,
            outputTokens: Number.isFinite(floorOut) && floorOut > 0 ? Math.floor(floorOut) : 5_000,
            tokenSource: 'estimate',
            model: opts.model,
            provider: 'codex-cli',
          });
          console.warn('[codex-cli] usage event missing — recorded COGS floor estimate');
        }
        cleanup();

        if (!text) {
          if (stderr.trim()) {
            console.warn(`[codex-cli] stderr:\n${stderr.trim().slice(0, 2000)}`);
          }
          const errMsg = extractErrorMessage(stdout, stderr) ?? `codex exited ${code ?? 'unknown'} with no output`;
          finish(() => reject(new Error(errMsg)));
          return;
        }
        finish(() => resolve({ text, threadId }));
      } catch (err) {
        finish(() => {
          cleanup();
          reject(err);
        });
      }
    });

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (child.pid !== undefined) {
        liveCodexChildren.delete(child.pid);
        try {
          codexChildListener.onExit?.(child.pid);
        } catch (err) {
          console.warn('[codex-cli] child exit listener failed:', (err as Error).message);
        }
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
}

/** Execute the real child-process lifecycle with a fixture binary. This narrow
 * test seam is intentionally separate from runCodexCliReview, so production
 * model/auth/binary pinning cannot be overridden by callers. */
export function runCodexExecForTest(
  prompt: string,
  opts: {
    binaryPath: string;
    model?: string;
    reasoningEffort?: string;
    signal?: AbortSignal;
    hardMs?: number;
    inactivityMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ text: string; threadId: string }> {
  return runCodexExecInner(prompt, {
    model: opts.model ?? DEFAULT_CODEX_CLI_MODEL,
    reasoningEffort: opts.reasoningEffort ?? DEFAULT_CODEX_CLI_REASONING_EFFORT,
    signal: opts.signal,
    binaryPath: opts.binaryPath,
    testTimeouts: {
      hardMs: opts.hardMs ?? 2_000,
      inactivityMs: opts.inactivityMs ?? 1_000,
    },
    testEnv: opts.env ?? process.env,
  });
}

function extractThreadId(stdout: string): string {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && event.thread_id) {
        return event.thread_id as string;
      }
    } catch {
      /* ignore non-json lines */
    }
  }
  return '';
}

function extractUsage(stdout: string): { input?: number; output?: number; reasoning?: number } | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed' && event.usage) {
        return {
          input: event.usage.input_tokens,
          output: event.usage.output_tokens,
          reasoning: event.usage.reasoning_output_tokens,
        };
      }
    } catch {
      /* ignore non-json lines */
    }
  }
  return undefined;
}

function readLastMessage(file: string): string {
  try {
    const stat = fs.statSync(file);
    const maxChars = 256_000;
    if (stat.size <= maxChars) return fs.readFileSync(file, 'utf8').trim();
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(maxChars);
      fs.readSync(fd, buffer, 0, maxChars, Math.max(0, stat.size - maxChars));
      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function extractErrorMessage(stdout: string, stderr: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'error' || event.type === 'turn.failed') {
        const msg =
          (event.message as string) ??
          (event.error?.message as string) ??
          JSON.stringify(event.error);
        if (msg) return msg;
      }
    } catch {
      /* ignore */
    }
  }
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return undefined;
  // Prefer a precise provider size/limit line over dumping the whole event stream
  // (which can contain earlier reconnect chatter and confuse rate-limit retries).
  const sizeHit = /request too large[^\n]{0,200}|context[_ ]length[_ ]exceeded[^\n]{0,200}|maximum context length[^\n]{0,200}/i.exec(
    combined,
  );
  if (sizeHit?.[0]) return sizeHit[0].trim();
  return combined;
}

function isStaleThreadError(message: string): boolean {
  return /no rollout found for thread|thread\/resume failed|thread not found|unknown thread/i.test(message);
}

/**
 * Run a review pass through the official `codex` CLI (OAuth/login flow), not the
 * OpenAI API. A new Codex session is started when `threadId` is omitted; the same
 * `threadId` can be passed back to resume the session for re-reviews of the same PR.
 */
export async function runCodexCliReview(
  files: ReviewableFile[],
  opts: CodexCliReviewOptions = {},
): Promise<CodexCliReviewResult> {
  if (opts.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
  // Codex runs with sandbox bypass on the dedicated worker VM. Diff-only prompt
  // input does not remove its shell/network capability, so the repository
  // allowlist gates the entire CLI invocation, not only checkout access.
  if (!isCodexRepoAllowed(opts.repoId)) {
    throw new Error(`Codex CLI review refused for non-allowlisted repository ${opts.repoId ?? '(unknown repo)'}`);
  }
  const cwd = opts.cwd;

  let promptMode: CodexPromptMode = opts.promptMode ?? (cwd ? 'lean' : 'full');
  let prompt = buildCodexPrompt(files, opts.context, { hasRepoCheckout: Boolean(cwd), mode: promptMode });
  // The agentic product stage is Luna. Do not accept a caller/env substitute:
  // unsupported Luna must fail closed instead of launching a costlier model.
  const model = DEFAULT_CODEX_CLI_MODEL;
  const effort = DEFAULT_CODEX_CLI_REASONING_EFFORT;
  const attemptState = { lastAttemptId: undefined as string | undefined, nextRetryIndex: 0 };

  // One full attempt on a given home: exec + stale-thread retry. Model identity
  // is fail-closed: a rejected Luna request must never launch a different,
  // unexpectedly expensive model.
  // Home locking lives inside runCodexExec (after resume-chain wait) so retries
  // and rate-limit sleeps never hold a CountingSemaphore slot.
  const attemptOnHome = async (
    homeIdx: number,
    threadId: string | undefined,
  ): Promise<{ text: string; threadId: string }> => {
    const home = CODEX_HOME_POOL[homeIdx];
    const authMode = detectCodexAuthMode(home);
    if (authMode !== 'apikey') {
      throw new Error(
        `codex-cli Luna requires API-key authentication; home ${homeIdx + 1} reports ${authMode}`,
      );
    }
    try {
      return await runCodexExec(prompt, {
        model,
        reasoningEffort: effort,
        threadId,
        cwd,
        home,
        homeIdx,
        onUsage: opts.onUsage,
        onAttempt: opts.onAttempt,
        attemptState,
        signal: opts.signal,
      });
    } catch (err) {
      const msg = (err as Error).message;
      // Stale session id (expired / not persisted / cleaned up) — start fresh
      // rather than failing the whole review.
      if (isStaleThreadError(msg) && threadId) {
        console.warn(`[codex-cli] thread ${threadId} not resumable, starting a new session`);
        return runCodexExec(prompt, {
          model,
          reasoningEffort: effort,
          cwd,
          home,
          homeIdx,
          onUsage: opts.onUsage,
          onAttempt: opts.onAttempt,
          attemptState,
          signal: opts.signal,
        });
      }
      throw err;
    }
  };

  // A per-minute TPM/RPM rate limit is RECOVERABLE by waiting — on a Tier-1
  // OpenAI account an agentic pass (many calls, growing context) hits it
  // routinely. Losing the whole agentic review to a limit that clears in ~60s
  // was silently degrading Verify to a plain one-shot API call, so HOLD and
  // retry instead. Wrapped around attemptOnHome so these waits don't consume
  // the outer loop's auth-failover budget. Hard quota (402) is NOT retried.
  const attemptWithRateLimitRetry = async (
    hIdx: number,
    tId: string | undefined,
  ): Promise<{ text: string; threadId: string }> => {
    const { maxAttempts, maxWaitMs, totalWaitBudgetMs } = resolveCodexRateLimitPolicy();
    let sleptMs = 0;
    for (let i = 0; ; i++) {
      if (opts.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
      try {
        return await attemptOnHome(hIdx, tId);
      } catch (err) {
        const msg = (err as Error).message;
        // Oversized payload/context cannot be waited out — fail immediately so
        // the pipeline can fall back to the plain API path without burning the
        // rate-limit sleep budget on a request that will never shrink.
        if (isOversizedModelRequest(msg)) {
          console.warn(
            `[codex-cli] request too large for model — failing fast (no rate-limit retry): ${msg.slice(0, 160)}`,
          );
          throw err;
        }
        if (i >= maxAttempts - 1 || !isRetryableRateLimit(msg)) throw err;
        // Honor the provider's advertised delay; otherwise back off toward the
        // ~1-minute TPM window. Jitter keeps concurrent passes from colliding.
        const advertised = parseRetryAfterMs(msg);
        // An advertised window longer than we'll ever wait can't be waited out —
        // retrying into it just burns another full agentic pass. Fail fast.
        if (advertised !== undefined && advertised > maxWaitMs) {
          console.warn(
            `[codex-cli] rate-limit window ${Math.round(advertised / 1000)}s exceeds max wait ` +
              `${Math.round(maxWaitMs / 1000)}s — failing fast rather than re-running the agentic pass`,
          );
          throw err;
        }
        const backoff = Math.min(15_000 * 2 ** i, maxWaitMs);
        const waitMs = Math.min((advertised ?? backoff) + Math.floor(Math.random() * 2_000), maxWaitMs);
        if (sleptMs + waitMs > totalWaitBudgetMs) {
          console.warn(
            `[codex-cli] rate-limit wait budget exhausted (${Math.round(sleptMs / 1000)}s of ` +
              `${Math.round(totalWaitBudgetMs / 1000)}s) — failing so the job requeues instead of holding a slot`,
          );
          throw err;
        }
        sleptMs += waitMs;
        await setProviderCooldown('luna', waitMs);
        console.warn(
          `[codex-cli] rate-limited — holding ${Math.round(waitMs / 1000)}s then retrying ` +
            `(attempt ${i + 1}/${maxAttempts}): ${msg.slice(0, 120)}`,
        );
        await waitForCodexRetry(waitMs, opts.signal);
      }
    }
  };

  const stored = decodeThreadRef(opts.threadId);
  let homeIdx = pickHome(stored.homeIdx);
  // Resume only on the session's own home; any other home starts fresh.
  let threadId = stored.homeIdx === homeIdx ? stored.threadId : undefined;
  let slimRetried = promptMode === 'slim';

  let result: { text: string; threadId: string } | undefined;
  for (let attempts = 0; ; attempts++) {
    if (opts.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
    try {
      result = await attemptWithRateLimitRetry(homeIdx, threadId);
      break;
    } catch (err) {
      const msg = (err as Error).message;
      // Opening turn / compact blew the request size: drop the dead thread and
      // retry ONCE with a minimal prompt so agentic still runs before the
      // pipeline falls back to a plain API call.
      if (isOversizedModelRequest(msg) && !slimRetried && Boolean(cwd)) {
        slimRetried = true;
        promptMode = 'slim';
        prompt = buildCodexPrompt(files, opts.context, { hasRepoCheckout: true, mode: 'slim' });
        threadId = undefined;
        console.warn(
          `[codex-cli] request too large — retrying once with slim fresh thread ` +
            `(prompt ${prompt.length} chars): ${msg.slice(0, 140)}`,
        );
        continue;
      }
      if (!isCodexAuthError(msg)) throw err;
      // OAuth failure on this account: bench it, alarm loudly, fail over to the
      // next healthy account with a fresh session. A revoked token must never
      // again silently degrade Verify to MiniMax-only "fast clean" reviews.
      homeDeadUntil[homeIdx] = Date.now() + CODEX_HOME_BENCH_MS;
      console.error(
        `[codex-cli] 🚨 CODEX AUTH FAILURE on account ${homeIdx + 1}/${CODEX_HOME_POOL.length} ` +
          `(${homeLabel(homeIdx)}) — token revoked/expired. Re-login: ` +
          `CODEX_HOME=${homeLabel(homeIdx)} codex login --device-auth. Error: ${msg}`,
      );
      const next = pickHome();
      if (next === homeIdx || attempts + 1 >= CODEX_HOME_POOL.length) throw err;
      console.warn(`[codex-cli] failing over to account ${next + 1}/${CODEX_HOME_POOL.length} (${homeLabel(next)})`);
      homeIdx = next;
      threadId = undefined; // sessions don't transfer across accounts
    }
  }

  if (!result.threadId && !threadId) {
    throw new Error('codex-cli did not return a session id');
  }

  const threadRef = encodeThreadRef(homeIdx, result.threadId || threadId!);
  const parsed = LlmReviewResponseSchema.parse(normalizeLlmResponse(extractJsonLoose(result.text)));
  const configuredMaxFindings = Number(process.env.ORVEX_MAX_FINDINGS ?? 25);
  const maxFindings =
    Number.isFinite(configuredMaxFindings) && configuredMaxFindings > 0
      ? Math.min(Math.floor(configuredMaxFindings), 1_000)
      : 25;
  const response: LlmReviewResponse = {
    ...parsed,
    findings: parsed.findings.slice(0, maxFindings).map((f) => ({
      ...f,
      ruleId: f.ruleId ?? `llm.${f.category}`,
    })),
  };

  return { response, threadId: threadRef };
}
