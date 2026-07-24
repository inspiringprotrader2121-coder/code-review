import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUserPrompt, loadOrvexRules, type ReviewPromptContext } from './prompt.js';
import { redactPatch, redactSecrets } from './redact.js';
import { extractJsonLoose, isRetryableRateLimit, parseRetryAfterMs } from './llm-client.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from './types.js';
import { normalizeLlmResponse } from './llm.js';

export interface CodexCliReviewOptions {
  /** Existing Codex session id to resume; omit to start a new session. */
  threadId?: string;
  /** Model override (defaults from env). */
  model?: string;
  /** Reasoning effort for models that support it. */
  reasoningEffort?: string;
  /** cross-file context: repo tree + imported files */
  context?: ReviewPromptContext;
  /** a read-only repo checkout codex may explore for a whole-repo sweep.
   *  Only honored when `repoId` is on the ORVEX_CODEX_CLI_REPOS allowlist —
   *  otherwise the checkout is REFUSED and the review runs diff-only. */
  cwd?: string;
  /** "owner/repo" of the repo being reviewed. Required for `cwd` to be honored
   *  (first-party allowlist enforcement — see isCodexRepoAllowed). */
  repoId?: string;
  /** token-usage callback for cost tracking. Without this the agentic pass —
   *  the most expensive one — reported $0 and spend was invisible. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

/**
 * FIRST-PARTY REPO ALLOWLIST — defense in depth, INDEPENDENT of the
 * ORVEX_CODEX_CLI feature flag. codex runs with
 * `--dangerously-bypass-approvals-and-sandbox` and shell access inside the repo
 * checkout, i.e. it executes whatever a malicious PR puts in the repo (build
 * scripts, hooks, "test fixtures"). That is a latent RCE surface, so a whole-repo
 * sweep is only ever handed to codex for repos explicitly listed in
 * ORVEX_CODEX_CLI_REPOS (comma-separated "owner/repo", case-insensitive;
 * "*" disables the check — NOT recommended). Unset/empty = no repo is ever
 * checked out for codex, no matter what the caller or the feature flag says.
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

function defaultModel(): string {
  return process.env.ORVEX_CODEX_CLI_MODEL ?? 'gpt-5.5';
}

function fallbackModel(): { model: string; reasoningEffort?: string } {
  return {
    model: 'gpt-5.5',
    reasoningEffort: process.env.ORVEX_CODEX_CLI_REASONING_EFFORT ?? 'xhigh',
  };
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

function codexBinary(): string {
  return process.env.ORVEX_CODEX_CLI_PATH ?? 'codex';
}

function shellEnv(codexHome?: string, homeIdx?: number): NodeJS.ProcessEnv {
  // Ensure the codex binary is discoverable if it was installed into a user npm
  // prefix (e.g. ~/.npm-global/bin) and the worker isn't started via a login shell.
  const extra = process.env.ORVEX_CODEX_CLI_PATH
    ? path.dirname(process.env.ORVEX_CODEX_CLI_PATH)
    : `${os.homedir()}/.npm-global/bin`;
  // MINIMAL, ALLOWLISTED env — NOT `{ ...process.env }`. codex runs untrusted PR
  // code as an agent with shell access; inheriting the full server env would hand
  // it every secret (Stripe key, GitHub App private key, all LLM keys, DB path).
  // codex authenticates via CODEX_HOME (below), not env, so no keys are needed
  // here. Only pass PATH, locale/cert basics, and the vars we explicitly set.
  const ALLOWED_ENV = [
    'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ];
  const env: NodeJS.ProcessEnv = { PATH: `${extra}${path.delimiter}${process.env.PATH ?? ''}` };
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

/**
 * CODEX ACCOUNT POOL — load-balance across MULTIPLE Codex OAuth accounts.
 *
 * Config: ORVEX_CODEX_HOMES=/home/x/.codex-orvex,/home/x/.codex-orvex2 (one
 * CODEX_HOME dir per logged-in account; run `CODEX_HOME=<dir> codex login
 * --device-auth` once per dir). Falls back to the single ORVEX_CODEX_HOME.
 *
 * - Calls are SERIALIZED PER HOME (concurrent refreshes of one auth.json race
 *   and revoke each other) but different homes run CONCURRENTLY — N accounts
 *   = N parallel codex reviews.
 * - A PR's session sticks to the home that created it (rollouts live in that
 *   home); the stored thread ref encodes the home as "hN:<threadId>".
 * - A home whose OAuth fails is benched for 15 minutes and the call fails
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
const homeQueues: Promise<unknown>[] = CODEX_HOME_POOL.map(() => Promise.resolve());
const homeBusy: number[] = CODEX_HOME_POOL.map(() => 0);
const homeDeadUntil: number[] = CODEX_HOME_POOL.map(() => 0);
const CODEX_HOME_BENCH_MS = 15 * 60_000;

function homeLabel(idx: number): string {
  return CODEX_HOME_POOL[idx] ?? '~/.codex';
}

/** Prefer the session's own home (affinity); otherwise the least-busy healthy home. */
function pickHome(preferred?: number): number {
  const now = Date.now();
  // Session affinity wins over balance: resuming a thread REQUIRES its own home.
  if (preferred !== undefined && preferred < CODEX_HOME_POOL.length && homeDeadUntil[preferred] <= now) {
    return preferred;
  }
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < CODEX_HOME_POOL.length; i++) {
    const dead = homeDeadUntil[i] > now;
    const score = (dead ? 1000 : 0) + homeBusy[i];
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function withHomeLock<T>(idx: number, fn: () => Promise<T>): Promise<T> {
  homeBusy[idx]++;
  const run = homeQueues[idx].then(fn, fn).finally(() => {
    homeBusy[idx]--;
  });
  homeQueues[idx] = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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

function buildPrompt(files: ReviewableFile[], context?: ReviewPromptContext, hasRepoCheckout?: boolean): string {
  const reviewable = files.filter((f) => f.patch && f.status !== 'removed');
  const redactedFiles = reviewable.map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: redactPatch(f.patch),
  }));

  const redactAll = (files?: Array<{ path: string; content: string }>) =>
    files?.map((f) => ({ ...f, content: redactSecrets(f.content) }));

  // When codex has the repo checked out at its CWD, DON'T paste the retrieval
  // context (related/dependents/others) into the prompt — it reads those files
  // itself, and the pasted copy is re-paid on EVERY exploration turn. On PR71
  // that inversion hit 1.5M input / 3.8k reasoning tokens for a 2-file PR and
  // codex missed a P1 it had already read the evidence for: a huge prompt DROWNS
  // attention on small PRs instead of helping. Diff + full changed files + tree
  // + intent stay in; everything else codex pulls on demand.
  const ctx = context
    ? {
        prTitle: context.prTitle,
        prBody: context.prBody,
        treePaths: context.treePaths,
        related: hasRepoCheckout ? undefined : redactAll(context.related),
        dependents: hasRepoCheckout ? undefined : redactAll(context.dependents),
        changedContents: redactAll(context.changedContents),
        others: hasRepoCheckout ? undefined : redactAll(context.others),
      }
    : undefined;

  const system = loadOrvexRules();
  const user = buildUserPrompt(redactedFiles, ctx);
  // Codex runs as an AGENT with the full repo checked out at its CWD — push it to
  // actually investigate instead of one-shotting from the excerpts below. This is
  // the whole point of using the Codex CLI over a plain API call.
  // ONLY claim a checkout exists when one actually does. Without this guard every
  // non-allowlisted repo got a prompt insisting the repo was at its CWD while
  // --cd pointed at an empty temp dir — codex burned turns rg'ing nothing.
  const explore = !hasRepoCheckout ? '' : [
    '## You are an agent — INVESTIGATE the repo, do not one-shot',
    'The COMPLETE repository is checked out at your current working directory. The',
    'diffs and file excerpts below are a STARTING POINT, not the whole story. Before',
    'you report, actively explore with your shell:',
    '- `rg`/`grep` for every changed symbol to find its callers and callees, and',
    '  check whether the change breaks any call site or invariant.',
    '- `cat`/`sed -n` the FULL changed files and their neighbours — a guard, default,',
    '  or error path elsewhere in the file often decides whether a hunk is a bug.',
    '- Trace data flow across files: where does this value come from, where does it go,',
    '  what validates it on THIS path (not just some other path).',
    '- Read the tests near the change; a missing or untouched test on new logic is a finding.',
    'Verify every hypothesis against the actual code you read. A finding you confirmed',
    'by reading the surrounding code is worth ten you guessed from a hunk. Keep',
    'investigating until you have concrete, file-and-line-anchored findings.',
    'Before submitting, do ONE more round: re-verify each finding against the code it',
    'cites, and probe one area you have not explored yet (tests, callers, or config)',
    '— the last look regularly turns up the subtlest bug.',
    '',
  ].join('\n');
  return explore ? `${system}\n\n${explore}\n${user}` : `${system}\n\n${user}`;
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
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  },
): Promise<{ text: string; threadId: string }> {
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
    const child = spawn(codexBinary(), args, {
      env: shellEnv(opts.home, opts.homeIdx),
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
    const hardMs = Math.max(60_000, finiteEnv(process.env.ORVEX_CODEX_TIMEOUT_MS, 1_800_000));
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      fn();
    };
    const killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL'); // whole group
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      finish(() => {
        cleanup();
        reject(new Error(`codex-cli exceeded ${hardMs}ms wall-clock cap`));
      });
    }, hardMs);

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
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
      try {
        const threadId = extractThreadId(stdout);
        const text = readLastMessage(lastMsgFile);
        const usage = extractUsage(stdout);
        // Report usage even on the FAILURE path: codex bills for the tokens it
        // burned whether or not it produced a parseable answer, and this is the
        // only place that usage is observable. Dropping it made the most
        // expensive pass report $0 and hid spend exactly when it mattered.
        if (usage) {
          opts.onUsage?.({
            inputTokens: usage.input ?? 0,
            outputTokens: (usage.output ?? 0) + (usage.reasoning ?? 0),
          });
          console.warn(
            `[codex-cli] usage: ${usage.input ?? 0} in / ${usage.reasoning ?? 0} reasoning / ${usage.output ?? 0} out tokens`,
          );
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
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
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
    return fs.readFileSync(file, 'utf8').trim();
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
  return combined || undefined;
}

function isUnsupportedModelError(message: string): boolean {
  return /not supported|unsupported model|model not found/i.test(message);
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
  // ALLOWLIST ENFORCEMENT (C1): a repo checkout is only handed to codex for
  // first-party allowlisted repos. Anything else silently drops to diff-only —
  // the checkout dir contains executable PR code and codex runs unsandboxed.
  let cwd = opts.cwd;
  if (cwd && !isCodexRepoAllowed(opts.repoId)) {
    console.warn(
      `[codex-cli] repo sweep REFUSED for ${opts.repoId ?? '(unknown repo)'} — not in ORVEX_CODEX_CLI_REPOS; running diff-only`,
    );
    cwd = undefined;
  }

  const prompt = buildPrompt(files, opts.context, Boolean(cwd));
  const model = opts.model ?? defaultModel();

  const effort = opts.reasoningEffort ?? process.env.ORVEX_CODEX_CLI_REASONING_EFFORT ?? 'xhigh';

  // One full attempt on a given home: exec + stale-thread retry + model fallback.
  const attemptOnHome = async (
    homeIdx: number,
    threadId: string | undefined,
  ): Promise<{ text: string; threadId: string }> => {
    const home = CODEX_HOME_POOL[homeIdx];
    try {
      return await withHomeLock(homeIdx, () =>
        runCodexExec(prompt, { model, reasoningEffort: effort, threadId, cwd, home, homeIdx, onUsage: opts.onUsage }),
      );
    } catch (err) {
      const msg = (err as Error).message;
      // Stale session id (expired / not persisted / cleaned up) — start fresh
      // rather than failing the whole review.
      if (isStaleThreadError(msg) && threadId) {
        console.warn(`[codex-cli] thread ${threadId} not resumable, starting a new session`);
        return withHomeLock(homeIdx, () =>
          runCodexExec(prompt, { model, reasoningEffort: effort, cwd, home, homeIdx, onUsage: opts.onUsage }),
        );
      }
      if (isUnsupportedModelError(msg) && model !== fallbackModel().model) {
        // Auto-fallback if the desired model isn't available on this Codex account —
        // keep the SAME (high) effort, don't silently drop to medium.
        const fb = fallbackModel();
        console.warn(`[codex-cli] ${model} not supported, falling back to ${fb.model} ${fb.reasoningEffort}`);
        return withHomeLock(homeIdx, () =>
          runCodexExec(prompt, {
            model: fb.model,
            reasoningEffort: fb.reasoningEffort ?? effort,
            threadId,
            cwd,
            home,
            homeIdx,
            onUsage: opts.onUsage,
          }),
        );
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
    const maxRetries = Math.max(1, Math.floor(finiteEnv(process.env.ORVEX_RATELIMIT_MAX_RETRIES, 4)));
    const maxWaitMs = Math.max(1_000, finiteEnv(process.env.ORVEX_CODEX_RATELIMIT_MAX_WAIT_MS, 90_000));
    for (let i = 0; ; i++) {
      try {
        return await attemptOnHome(hIdx, tId);
      } catch (err) {
        const msg = (err as Error).message;
        if (i >= maxRetries - 1 || !isRetryableRateLimit(msg)) throw err;
        // Honor the provider's advertised delay; otherwise back off toward the
        // ~1-minute TPM window. Jitter keeps concurrent passes from colliding.
        const advertised = parseRetryAfterMs(msg);
        const backoff = Math.min(15_000 * 2 ** i, maxWaitMs);
        const waitMs = Math.min((advertised ?? backoff) + Math.floor(Math.random() * 2_000), maxWaitMs);
        console.warn(
          `[codex-cli] rate-limited — holding ${Math.round(waitMs / 1000)}s then retrying ` +
            `(attempt ${i + 1}/${maxRetries}): ${msg.slice(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  };

  const stored = decodeThreadRef(opts.threadId);
  let homeIdx = pickHome(stored.homeIdx);
  // Resume only on the session's own home; any other home starts fresh.
  let threadId = stored.homeIdx === homeIdx ? stored.threadId : undefined;

  let result: { text: string; threadId: string } | undefined;
  for (let attempts = 0; ; attempts++) {
    try {
      result = await attemptWithRateLimitRetry(homeIdx, threadId);
      break;
    } catch (err) {
      const msg = (err as Error).message;
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
  const maxFindings = Number(process.env.ORVEX_MAX_FINDINGS ?? 25);
  const response: LlmReviewResponse = {
    ...parsed,
    findings: parsed.findings.slice(0, maxFindings).map((f) => ({
      ...f,
      ruleId: f.ruleId ?? `llm.${f.category}`,
    })),
  };

  return { response, threadId: threadRef };
}
