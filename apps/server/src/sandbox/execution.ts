import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
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

let activeSandboxes = 0;
const waiters: Array<() => void> = [];
const activeWorkdirs = new Set<string>();

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  activeSandboxes = Math.max(0, activeSandboxes - 1);
}

async function acquireSlot(runtime: SandboxRuntimeOptions, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new SandboxCancelledError();
  if (activeSandboxes < runtime.maxConcurrentSandboxes) {
    activeSandboxes++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const clear = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const entry = () => {
      if (settled) return;
      settled = true;
      clear();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const index = waiters.indexOf(entry);
      if (index >= 0) waiters.splice(index, 1);
      clear();
      reject(new SandboxCancelledError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = waiters.indexOf(entry);
      if (index >= 0) waiters.splice(index, 1);
      clear();
      reject(new Error(`sandbox slot wait timed out after ${runtime.slotWaitMs}ms`));
    }, runtime.slotWaitMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(entry);
  });
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
  let args: string[];
  const name = `orvex-rv-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  try {
    safeWorkdir = assertSafeSandboxWorkdir(opts.workdir);
    args = buildSandboxDockerArgs({ ...opts, workdir: safeWorkdir }, name, runtime);
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: `[sandbox] rejected unsafe runtime configuration: ${(error as Error).message}`,
      timedOut: false,
      durationMs: 0,
    };
  }
  try {
    await acquireSlot(runtime, opts.signal);
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
    releaseSlot();
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
    releaseSlot();
    return {
      exitCode: null,
      stdout: '',
      stderr: '[sandbox] rejected concurrent reuse of a runtime checkout',
      timedOut: false,
      durationMs: 0,
    };
  }
  activeWorkdirs.add(safeWorkdir);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child: ReturnType<SandboxSpawn>;
    try {
      child = spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      activeWorkdirs.delete(safeWorkdir);
      releaseSlot();
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
    let capturedBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimedOut = false;
    let quotaTimer: ReturnType<typeof setInterval> | undefined;
    let cleanup: Promise<void> | undefined;
    const cleanupContainer = (killFirst: boolean): Promise<void> => {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        const ownership = await runBoundedDockerCommandWithSpawn(
          [
            'inspect',
            '--format',
            '{{printf "%s\\t%s" (index .Config.Labels "orvex.managed") (index .Config.Labels "orvex.runtime-verify")}}',
            name,
          ],
          spawnImpl,
        );
        if (
          ownership.exitCode !== 0 ||
          ownership.timedOut ||
          ownership.stdout.trim() !== 'true\ttrue'
        )
          return;
        if (killFirst) await waitForDockerCommand(spawnImpl, ['kill', name]);
        await waitForDockerCommand(spawnImpl, ['rm', '--force', name]);
      })();
      return cleanup;
    };
    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (quotaTimer) clearInterval(quotaTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      activeWorkdirs.delete(safeWorkdir);
      releaseSlot();
      resolve(result);
    };
    const cap = (buffer: string, chunk: Buffer) => {
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (remaining <= 0) return buffer;
      const permitted = chunk.subarray(0, remaining);
      capturedBytes += permitted.length;
      return buffer + permitted.toString('utf8');
    };
    const failAndCleanup = (result: SandboxResult, killFirst: boolean) => {
      const cleanupPromise = cleanupContainer(killFirst);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      void cleanupPromise.then(() => finish(result));
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
      stdout = cap(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      armInactivityTimer();
      stderr = cap(stderr, chunk);
    });
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
      if (!cleanup)
        finish({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });
  });
}
