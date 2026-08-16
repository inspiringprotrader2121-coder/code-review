import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTAINER_CLEANUP_RETRY_MS,
  CONTAINER_CLEANUP_TIMEOUT_MS,
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  MAX_HOST_SANDBOX_SLOTS,
  MAX_CAPTURE_BYTES,
  WORKDIR_QUOTA_POLL_MS,
  type SandboxResult,
  type SandboxRunOptions,
  type SandboxRuntimeOptions,
  type SandboxSpawn,
} from './contracts.js';
import { runBoundedDockerCommandWithSpawn, waitForDockerCommand } from './docker-control.js';
import {
  assertSafeSandboxWorkdir,
  assertWorkdirWithinQuota,
  workdirMaxBytes,
} from './filesystem.js';
import { buildSandboxDockerArgs } from './policy.js';
import { checkCodexSandboxRuntimeReadiness, checkSandboxRuntimeReadiness } from './readiness.js';

class SandboxCancelledError extends Error {
  constructor() {
    super('sandbox run cancelled');
    this.name = 'SandboxCancelledError';
  }
}

const activeWorkdirs = new Set<string>();
const STDERR_CAPTURE_BYTES = Math.min(16_000, Math.floor(MAX_CAPTURE_BYTES / 4));
const STDOUT_CAPTURE_BYTES = MAX_CAPTURE_BYTES - STDERR_CAPTURE_BYTES;
const STDOUT_TAIL_CAPTURE_BYTES = Math.min(16_000, Math.floor(STDOUT_CAPTURE_BYTES / 3));
const STDERR_TAIL_CAPTURE_BYTES = Math.min(4_000, Math.floor(STDERR_CAPTURE_BYTES / 3));
const TRUNCATION_SEPARATOR = Buffer.from('\n[sandbox output truncated]\n');

/**
 * Keep the beginning of a tool stream for startup/error protocol and its tail
 * for terminal protocol such as the broker's final usage record. The combined
 * stdout/stderr memory ceiling remains MAX_CAPTURE_BYTES.
 */
class BoundedOutputCapture {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private truncated = false;

  constructor(
    private readonly limit: number,
    private readonly tailLimit: number,
  ) {}

  append(chunk: Buffer): void {
    if (!this.truncated) {
      const combined = Buffer.concat([this.head, chunk]);
      if (combined.length <= this.limit) {
        this.head = combined;
        return;
      }
      this.truncated = true;
      const headLimit = this.limit - this.tailLimit - TRUNCATION_SEPARATOR.length;
      this.head = combined.subarray(0, headLimit);
      this.tail = combined.subarray(Math.max(headLimit, combined.length - this.tailLimit));
      return;
    }
    const combined = Buffer.concat([this.tail, chunk]);
    this.tail = combined.subarray(Math.max(0, combined.length - this.tailLimit));
  }

  text(): string {
    return Buffer.concat(
      this.truncated ? [this.head, TRUNCATION_SEPARATOR, this.tail] : [this.head],
    ).toString('utf8');
  }
}

interface SandboxSlotLease {
  readonly ownerToken: string;
  release(): void;
}

interface SlotOwner {
  pid: number;
  acquiredAt: number;
  token: string;
  processIdentity: string;
}

const SLOT_ROOT_NAME = 'orvex-sandbox-slots-v1';

function slotRoot(runtime: SandboxRuntimeOptions): string {
  return runtime.slotDirectory ?? path.join(os.tmpdir(), SLOT_ROOT_NAME);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    return startTicks && /^\d+$/.test(startTicks) ? `${pid}:${startTicks}` : null;
  } catch {
    return null;
  }
}

function assertPrivateSlotRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('sandbox slot directory must be a private service-owned directory');
  }
}

function readSlotOwner(slotPath: string): SlotOwner | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(slotPath, 'owner.json'), 'utf8'),
    ) as SlotOwner;
    return Number.isSafeInteger(value.pid) &&
      Number.isFinite(value.acquiredAt) &&
      typeof value.token === 'string' &&
      /^[a-f0-9-]{36}$/.test(value.token) &&
      typeof value.processIdentity === 'string' &&
      value.processIdentity.length <= 100
      ? value
      : null;
  } catch {
    return null;
  }
}

function readUntrustedOwnerPid(slotPath: string): number | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(slotPath, 'owner.json'), 'utf8')) as {
      pid?: unknown;
    };
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : null;
  } catch {
    return null;
  }
}

function reclaimStaleSlot(slotPath: string, staleMs: number, now: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(slotPath);
  } catch {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const owner = readSlotOwner(slotPath);
  const legacyPid = owner ? null : readUntrustedOwnerPid(slotPath);
  const stale = owner
    ? !processIsAlive(owner.pid) ||
      (processIdentity(owner.pid) !== null && processIdentity(owner.pid) !== owner.processIdentity)
    : (legacyPid !== null && !processIsAlive(legacyPid)) || now - stat.mtimeMs >= staleMs;
  if (!stale) return;
  const quarantine = `${slotPath}.reclaim-${randomUUID()}`;
  try {
    fs.renameSync(slotPath, quarantine);
  } catch {
    return;
  }
  try {
    fs.rmSync(quarantine, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
  } catch {
    // A quarantined stale lease never grants capacity, so safety wins over reuse.
  }
}

function tryAcquireHostSlot(runtime: SandboxRuntimeOptions): SandboxSlotLease | null {
  const root = slotRoot(runtime);
  assertPrivateSlotRoot(root);
  const capacity = Math.min(MAX_HOST_SANDBOX_SLOTS, runtime.maxConcurrentSandboxes);
  for (let index = 0; index < capacity; index++) {
    const slotPath = path.join(root, `slot-${index}`);
    try {
      fs.mkdirSync(slotPath, { mode: 0o700 });
      const token = randomUUID();
      const identity = processIdentity(process.pid) ?? `${process.pid}:portable`;
      try {
        fs.writeFileSync(
          path.join(slotPath, 'owner.json'),
          JSON.stringify({
            pid: process.pid,
            acquiredAt: Date.now(),
            token,
            processIdentity: identity,
          }),
          { encoding: 'utf8', mode: 0o600, flag: 'wx' },
        );
      } catch (error) {
        fs.rmSync(slotPath, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return {
        ownerToken: token,
        release() {
          if (released) return;
          released = true;
          try {
            if (readSlotOwner(slotPath)?.token !== token) return;
            const quarantine = `${slotPath}.release-${token}`;
            fs.renameSync(slotPath, quarantine);
            fs.rmSync(quarantine, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
          } catch {
            // A leaked slot is reclaimed after this worker dies; never over-admit.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      reclaimStaleSlot(slotPath, runtime.slotStaleMs, Date.now());
    }
  }
  return null;
}

async function acquireSlot(
  runtime: SandboxRuntimeOptions,
  signal?: AbortSignal,
): Promise<SandboxSlotLease> {
  const deadline = Date.now() + runtime.slotWaitMs;
  for (;;) {
    if (signal?.aborted) throw new SandboxCancelledError();
    const lease = tryAcquireHostSlot(runtime);
    if (lease) return lease;
    if (Date.now() >= deadline)
      throw new Error(
        `sandbox slot wait timed out after ${runtime.slotWaitMs}ms; admission timed out; retry-after: ${Math.max(1, Math.ceil(runtime.slotWaitMs / 1000))}`,
      );
    await sleep(Math.min(CONTAINER_CLEANUP_RETRY_MS, Math.max(1, deadline - Date.now())));
  }
}

function unavailableResult(reason: string, signal?: AbortSignal): SandboxResult {
  return {
    exitCode: null,
    stdout: '',
    stderr: `[sandbox] unavailable: ${reason}`,
    timedOut: false,
    cancelled: signal?.aborted,
    durationMs: 0,
  };
}

export async function runInSandbox(
  opts: SandboxRunOptions,
  runtime: SandboxRuntimeOptions = DEFAULT_SANDBOX_RUNTIME_OPTIONS,
): Promise<SandboxResult> {
  const readiness =
    opts.profile === 'agentic-codex'
      ? await checkCodexSandboxRuntimeReadiness({ runtime, signal: opts.signal })
      : await checkSandboxRuntimeReadiness({ runtime, signal: opts.signal });
  if (!readiness.ready) return unavailableResult(readiness.reason, opts.signal);
  if (readiness.image !== opts.image) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '[sandbox] rejected image that differs from the configured runtime image',
      timedOut: false,
      durationMs: 0,
    };
  }
  return runInSandboxWithSpawnForTest(opts, spawn, runtime);
}

/** Test-only process seam. Production calls the readiness-gated function above. */
export async function runInSandboxWithSpawnForTest(
  opts: SandboxRunOptions,
  spawnImpl: SandboxSpawn,
  runtime: SandboxRuntimeOptions = DEFAULT_SANDBOX_RUNTIME_OPTIONS,
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const inactivityTimeoutMs = opts.inactivityTimeoutMs;
  if (opts.signal?.aborted)
    return {
      exitCode: null,
      stdout: '',
      stderr: '[sandbox] cancelled',
      timedOut: false,
      cancelled: true,
      durationMs: 0,
    };
  let safeWorkdir: string;
  const name = `orvex-rv-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  try {
    safeWorkdir = assertSafeSandboxWorkdir(opts.workdir);
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: `[sandbox] rejected unsafe runtime configuration: ${(error as Error).message}`,
      timedOut: false,
      durationMs: 0,
    };
  }
  let slot: SandboxSlotLease;
  try {
    slot = await acquireSlot(runtime, opts.signal);
  } catch (error) {
    if (error instanceof SandboxCancelledError)
      return {
        exitCode: null,
        stdout: '',
        stderr: '[sandbox] cancelled',
        timedOut: false,
        cancelled: true,
        durationMs: 0,
      };
    throw error;
  }
  if (opts.signal?.aborted) {
    slot.release();
    return {
      exitCode: null,
      stdout: '',
      stderr: '[sandbox] cancelled',
      timedOut: false,
      cancelled: true,
      durationMs: 0,
    };
  }
  if (activeWorkdirs.has(safeWorkdir)) {
    slot.release();
    return {
      exitCode: null,
      stdout: '',
      stderr: '[sandbox] rejected concurrent reuse of a runtime checkout',
      timedOut: false,
      durationMs: 0,
    };
  }
  let args: string[];
  try {
    args = buildSandboxDockerArgs(
      { ...opts, workdir: safeWorkdir },
      name,
      runtime,
      slot.ownerToken,
    );
  } catch (error) {
    slot.release();
    return {
      exitCode: null,
      stdout: '',
      stderr: `[sandbox] rejected unsafe runtime configuration: ${(error as Error).message}`,
      timedOut: false,
      durationMs: 0,
    };
  }
  activeWorkdirs.add(safeWorkdir);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child: ReturnType<SandboxSpawn>;
    try {
      child = spawnImpl('docker', args, {
        stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      activeWorkdirs.delete(safeWorkdir);
      slot.release();
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `[sandbox] failed to launch docker: ${(error as Error).message}`,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    const stdoutCapture = new BoundedOutputCapture(STDOUT_CAPTURE_BYTES, STDOUT_TAIL_CAPTURE_BYTES);
    const stderrCapture = new BoundedOutputCapture(STDERR_CAPTURE_BYTES, STDERR_TAIL_CAPTURE_BYTES);
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimedOut = false;
    let quotaTimer: ReturnType<typeof setInterval> | undefined;
    let cleanup: Promise<boolean> | undefined;
    const cleanupContainer = (killFirst: boolean): Promise<boolean> => {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        const deadline = Date.now() + CONTAINER_CLEANUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const ownership = await runBoundedDockerCommandWithSpawn(
            [
              'inspect',
              '--format',
              '{{printf "%s\\t%s" (index .Config.Labels "orvex.managed") (index .Config.Labels "orvex.runtime-verify")}}',
              name,
            ],
            spawnImpl,
          );
          if (ownership.exitCode === 0 && !ownership.timedOut) {
            if (ownership.stdout.trim() !== 'true\ttrue') return false;
            if (killFirst) await waitForDockerCommand(spawnImpl, ['kill', name]);
            await waitForDockerCommand(spawnImpl, ['rm', '--force', name]);
          } else if (/no such (?:object|container)/i.test(ownership.stderr)) {
            return true;
          }
          await sleep(CONTAINER_CLEANUP_RETRY_MS);
        }
        return false;
      })().finally(() => {
        cleanup = undefined;
      });
      return cleanup;
    };
    const reconcileInBackground = (killFirst: boolean) => {
      const retry = () => {
        void cleanupContainer(killFirst).then((removed) => {
          if (removed) {
            slot.release();
            return;
          }
          const timer = setTimeout(retry, 1_000);
          timer.unref?.();
        });
      };
      retry();
    };
    const finish = (result: SandboxResult, releaseSlot = true) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (quotaTimer) clearInterval(quotaTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      activeWorkdirs.delete(safeWorkdir);
      if (releaseSlot) slot.release();
      resolve(result);
    };
    const cap = (capture: BoundedOutputCapture, chunk: Buffer) => {
      capture.append(chunk);
      return capture.text();
    };
    const failAndCleanup = (result: SandboxResult, killFirst: boolean) => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      const cleanupPromise = cleanupContainer(killFirst);
      void cleanupPromise.then((removed) => {
        finish(result, removed);
        if (!removed) reconcileInBackground(killFirst);
      });
    };
    const armInactivityTimer = () => {
      if (!inactivityTimeoutMs || settled) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        inactivityTimedOut = true;
        timedOut = true;
        failAndCleanup(
          {
            exitCode: null,
            stdout,
            stderr: `${stderr}\n[sandbox] no container output for ${inactivityTimeoutMs}ms`.trim(),
            timedOut: true,
            inactivityTimedOut: true,
            durationMs: Date.now() - startedAt,
          },
          true,
        );
      }, inactivityTimeoutMs);
    };
    const onAbort = () =>
      failAndCleanup(
        {
          exitCode: null,
          stdout,
          stderr: `${stderr}\n[sandbox] cancelled`.trim(),
          timedOut: false,
          cancelled: true,
          durationMs: Date.now() - startedAt,
        },
        true,
      );
    child.stdout?.on('data', (chunk: Buffer) => {
      armInactivityTimer();
      stdout = cap(stdoutCapture, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      armInactivityTimer();
      stderr = cap(stderrCapture, chunk);
    });
    if (opts.stdin !== undefined && !child.stdin) {
      failAndCleanup(
        {
          exitCode: null,
          stdout,
          stderr: `${stderr}\n[sandbox] Docker stdin pipe unavailable`.trim(),
          timedOut: false,
          durationMs: Date.now() - startedAt,
        },
        true,
      );
      return;
    }
    if (opts.stdin !== undefined) {
      // Docker must receive the Codex prompt through attached stdin. Codex 0.147
      // exits successfully without running when `exec -` reads a mounted file.
      child.stdin!.on('error', () => {
        /* A concurrent container exit is handled by the child lifecycle. */
      });
      child.stdin!.end(opts.stdin);
    }
    quotaTimer = setInterval(() => {
      if (settled) return;
      try {
        assertWorkdirWithinQuota(safeWorkdir, workdirMaxBytes(runtime));
      } catch (error) {
        failAndCleanup(
          {
            exitCode: null,
            stdout,
            stderr: `${stderr}\n[sandbox] ${(error as Error).message}`.trim(),
            timedOut: false,
            durationMs: Date.now() - startedAt,
          },
          true,
        );
      }
    }, WORKDIR_QUOTA_POLL_MS);
    quotaTimer.unref?.();
    timer = setTimeout(() => {
      timedOut = true;
      failAndCleanup(
        {
          exitCode: null,
          stdout,
          stderr,
          timedOut: true,
          inactivityTimedOut,
          durationMs: Date.now() - startedAt,
        },
        true,
      );
    }, timeoutMs);
    armInactivityTimer();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.on('error', (error) =>
      failAndCleanup(
        {
          exitCode: null,
          stdout,
          stderr: `${stderr}\n[sandbox] failed to launch docker: ${error.message}`.trim(),
          timedOut,
          durationMs: Date.now() - startedAt,
        },
        true,
      ),
    );
    child.on('close', (code) => {
      if (cleanup) return;
      const result = {
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      };
      void cleanupContainer(false).then((removed) => {
        finish(result, removed);
        if (!removed) reconcileInBackground(false);
      });
    });
  });
}
