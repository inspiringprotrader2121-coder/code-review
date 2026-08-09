import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Hardened Docker sandbox for the Tier-2 execution engine (the TREX equivalent).
 *
 * Running code from a pull request is the premium capability, and it is the most
 * security-sensitive thing this product does. Every run is:
 *  - ephemeral (`--rm`), non-root (`-u`), with a read-only root filesystem
 *  - resource-capped (memory, cpus, pid count) so a fork bomb / OOM can't take
 *    the host down
 *  - network-isolated by default (`--network none`); the caller opts into a
 *    network only for a dependency-install phase
 *  - killed at a hard wall-clock timeout, with captured output byte-capped
 *  - workdir disk-quota checked by callers via {@link assertWorkdirWithinQuota}
 *
 * This gates untrusted execution behind a small, auditable surface. It is OFF by
 * default (plan + ORVEX_CODE_EXECUTION) — turning it on for public/untrusted
 * repos should follow a review of these flags.
 */

export interface SandboxRunOptions {
  /** absolute host path mounted at /work */
  workdir: string;
  /** digest-pinned container image already present in the internal runtime */
  image: string;
  /** shell command run as `sh -c "<command>"` inside /work */
  command: string;
  /** hard wall-clock limit; the container is killed when it elapses */
  timeoutMs?: number;
  /** memory cap, e.g. "2g" */
  memory?: string;
  /** cpu cap, e.g. "2" */
  cpus?: string;
  /** 'none' (default, isolated) or 'bridge' (only for a dependency-install phase) */
  network?: 'none' | 'bridge';
  /** extra env passed through to the container */
  env?: Record<string, string>;
  /** mount /work read-only when the command does not need to write artifacts */
  readOnlyWorkdir?: boolean;
  /** cancel while waiting for a slot or while the container is running */
  signal?: AbortSignal;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  cancelled?: boolean;
}

export type SandboxRuntimeReadiness =
  | { ready: true; image: string }
  | { ready: false; reason: string };

export interface SandboxRuntimeReadinessOptions {
  /** Defaults to the production execution switch. Supplying this is useful in tests. */
  enabled?: boolean;
  /** Defaults to ORVEX_SANDBOX_IMAGE. Runtime execution never has an implicit image. */
  image?: string;
  /** Test seam: readiness must not need a Docker daemon during unit tests. */
  inspectImage?: (image: string, signal?: AbortSignal) => Promise<boolean>;
  /** Test seam for proving the selected daemon reports Docker rootless mode. */
  inspectRootlessRuntime?: (signal?: AbortSignal) => Promise<boolean>;
  /** Defaults to DOCKER_HOST; accepted only for the current uid's rootless socket. */
  dockerHost?: string;
  signal?: AbortSignal;
}

const MAX_CAPTURE_BYTES = 64_000; // keep evidence readable and bounded
const SANDBOX_READINESS_TIMEOUT_MS = 10_000;
const SANDBOX_DOCKER_COMMAND_TIMEOUT_MS = 10_000;
const ORVEX_MANAGED_LABEL = 'orvex.managed=true';
const ORVEX_RUNTIME_LABEL = 'orvex.runtime-verify=true';

export interface SandboxStartupPreparation {
  enabled: boolean;
  removedContainers: number;
  image?: string;
}

export interface SandboxDockerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SandboxDockerCommandRunner = (
  args: readonly string[],
) => Promise<SandboxDockerCommandResult>;

export interface SandboxStartupPreparationOptions {
  /** Defaults to the production execution switch. Supplying this is useful in tests. */
  enabled?: boolean;
  /** Test seam for Docker command bounds and label selection. */
  runDockerCommand?: SandboxDockerCommandRunner;
  /** Test seam for the runtime image readiness check. */
  checkReadiness?: () => Promise<SandboxRuntimeReadiness>;
}

/** A tag can be moved; a content digest cannot. Runtime execution accepts only the latter. */
export function isDigestPinnedSandboxImage(image: string | undefined): image is string {
  return Boolean(image && /^[^@\s]+@sha256:[a-f0-9]{64}$/i.test(image));
}

function configuredSandboxImage(): string | undefined {
  const image = process.env.ORVEX_SANDBOX_IMAGE;
  return image && image.trim() === image ? image : undefined;
}

// Global cap on concurrent sandbox containers across ALL jobs/tenants — the
// per-container limits bound one container; this bounds the fleet so a burst of
// hostile PRs can't spawn unbounded containers and pin the host.
const configuredMaxSandboxes = Number(process.env.ORVEX_MAX_SANDBOXES ?? 2);
const MAX_SANDBOXES =
  Number.isFinite(configuredMaxSandboxes) && configuredMaxSandboxes > 0
    ? Math.min(Math.floor(configuredMaxSandboxes), 64)
    : 2;
const SLOT_WAIT_MS = (() => {
  const raw = Number(process.env.ORVEX_SANDBOX_SLOT_WAIT_MS ?? 600_000);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 3_600_000) : 600_000;
})();

/** Default /work disk budget (4 GiB). Override with ORVEX_SANDBOX_WORKDIR_MAX_BYTES. */
export const DEFAULT_WORKDIR_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export function workdirMaxBytes(): number {
  const raw = Number(process.env.ORVEX_SANDBOX_WORKDIR_MAX_BYTES ?? DEFAULT_WORKDIR_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_WORKDIR_MAX_BYTES;
}

/** Recursive on-disk size of a workdir (files only; follows neither symlinks nor mounts). */
export function measureWorkdirBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          stack.push(full);
        } else if (ent.isFile()) {
          total += fs.statSync(full).size;
        }
      } catch {
        /* race / permission — skip */
      }
    }
  }
  return total;
}

/**
 * Fail the run when /work has grown past the configured disk budget (typical
 * after a hostile install that dumps huge node_modules or artifacts).
 */
export function assertWorkdirWithinQuota(workdir: string, maxBytes = workdirMaxBytes()): number {
  const used = measureWorkdirBytes(workdir);
  if (used > maxBytes) {
    throw new Error(`sandbox workdir exceeds ${maxBytes}-byte disk quota (used ${used} bytes)`);
  }
  return used;
}

let activeSandboxes = 0;
const waiters: Array<() => void> = [];
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    // Transfer the released slot directly to the oldest waiter. Keeping the
    // active count unchanged avoids a race where a new caller steals the slot
    // before the resumed waiter gets its microtask.
    next();
    return;
  }
  activeSandboxes = Math.max(0, activeSandboxes - 1);
}

export function buildSandboxDockerArgs(opts: SandboxRunOptions, name: string): string[] {
  const mountMode = opts.readOnlyWorkdir ? 'ro' : 'rw';
  const args: string[] = [
    'run',
    '--rm',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    'orvex.managed=true',
    '--label',
    'orvex.runtime-verify=true',
    '--network',
    opts.network ?? 'none',
    '--memory',
    opts.memory ?? '2g',
    '--memory-swap',
    opts.memory ?? '2g', // no swap beyond memory
    '--cpus',
    opts.cpus ?? '2',
    '--pids-limit',
    '512',
    '--read-only',
    '--tmpfs',
    '/tmp:size=512m,noexec,nosuid,nodev', // writable scratch, but not executable
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-u',
    '1000:1000',
    '-v',
    `${opts.workdir}:/work:${mountMode}`,
    '-w',
    '/work',
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(opts.image, 'sh', '-c', opts.command);
  return args;
}

class SandboxCancelledError extends Error {
  constructor() {
    super('sandbox run cancelled');
    this.name = 'SandboxCancelledError';
  }
}

async function acquireSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new SandboxCancelledError();
  if (activeSandboxes < MAX_SANDBOXES) {
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
      const idx = waiters.indexOf(entry);
      if (idx >= 0) waiters.splice(idx, 1);
      clear();
      reject(new SandboxCancelledError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = waiters.indexOf(entry);
      if (idx >= 0) waiters.splice(idx, 1);
      clear();
      reject(new Error(`sandbox slot wait timed out after ${SLOT_WAIT_MS}ms`));
    }, SLOT_WAIT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(entry);
  });
}

type SandboxSpawn = typeof spawn;
const CONTAINER_CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Check the Docker daemon can resolve the exact locally-present image. This
 * deliberately does not pull: execution must fail closed until an operator has
 * installed the reviewed digest on the host.
 */
function inspectSandboxImageWithSpawn(
  image: string,
  signal: AbortSignal | undefined,
  spawnImpl: SandboxSpawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<SandboxSpawn> | undefined;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* an unavailable Docker client cannot keep readiness pending */
      }
      finish(false);
    };
    const timer = setTimeout(onAbort, SANDBOX_READINESS_TIMEOUT_MS);
    try {
      child = spawnImpl('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
        stdio: 'ignore',
      });
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    } catch {
      finish(false);
    }
  });
}

function inspectRootlessRuntimeWithSpawn(
  signal: AbortSignal | undefined,
  spawnImpl: SandboxSpawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<SandboxSpawn> | undefined;
    let stdout = '';
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => {
      try { child?.kill('SIGKILL'); } catch { /* unavailable runtime */ }
      finish(false);
    };
    const timer = setTimeout(onAbort, SANDBOX_READINESS_TIMEOUT_MS);
    try {
      child = spawnImpl(
        'docker',
        ['info', '--format', '{{range .SecurityOptions}}{{println .}}{{end}}'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
      });
      child.once('error', () => finish(false));
      child.once('close', (code) => {
        const rootless = stdout.split(/\r?\n/).some((line) => /(?:^|=)rootless$/.test(line.trim()));
        finish(code === 0 && rootless);
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    } catch {
      finish(false);
    }
  });
}

/**
 * Fail-closed preflight for the internal execution runtime. A digest-pinned
 * image is mandatory and must already be available through the current Docker
 * socket; `docker run` is never allowed to pull an image on demand.
 */
export async function checkSandboxRuntimeReadiness(
  opts: SandboxRuntimeReadinessOptions = {},
): Promise<SandboxRuntimeReadiness> {
  const enabled = opts.enabled ?? process.env.ORVEX_CODE_EXECUTION === '1';
  if (!enabled) return { ready: false, reason: 'code execution is disabled' };
  if (opts.signal?.aborted) return { ready: false, reason: 'runtime verification cancelled' };

  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    return { ready: false, reason: 'rootless Docker requires a POSIX service-account uid' };
  }
  const expectedDockerHost = `unix:///run/user/${currentUid}/docker.sock`;
  const dockerHost = opts.dockerHost ?? process.env.DOCKER_HOST;
  if (dockerHost !== expectedDockerHost) {
    return {
      ready: false,
      reason: `DOCKER_HOST must select the service account rootless socket ${expectedDockerHost}`,
    };
  }

  const image = opts.image ?? configuredSandboxImage();
  if (!isDigestPinnedSandboxImage(image)) {
    return {
      ready: false,
      reason: 'ORVEX_SANDBOX_IMAGE must be a digest-pinned image (for example registry/image@sha256:<64-hex>)',
    };
  }

  const inspectImage = opts.inspectImage ?? ((candidate, signal) =>
    inspectSandboxImageWithSpawn(candidate, signal, spawn));
  const inspectRootlessRuntime = opts.inspectRootlessRuntime ?? ((signal) =>
    inspectRootlessRuntimeWithSpawn(signal, spawn));
  if (!(await inspectRootlessRuntime(opts.signal))) {
    return { ready: false, reason: 'selected Docker daemon does not report rootless mode' };
  }
  const available = await inspectImage(image, opts.signal);
  if (opts.signal?.aborted) return { ready: false, reason: 'runtime verification cancelled' };
  if (!available) {
    return { ready: false, reason: 'internal sandbox runtime or configured image is unavailable' };
  }
  return { ready: true, image };
}

function waitForDockerCommand(
  spawnImpl: SandboxSpawn,
  args: string[],
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    let command: ReturnType<SandboxSpawn> | undefined;
    const timer = setTimeout(() => {
      try {
        command?.kill('SIGKILL');
      } catch {
        /* the bounded cleanup attempt has already failed */
      }
      finish();
    }, CONTAINER_CLEANUP_TIMEOUT_MS);
    try {
      command = spawnImpl('docker', args, { stdio: 'ignore' });
      command.once('error', finish);
      command.once('close', finish);
    } catch {
      finish();
    }
  });
}

/**
 * Run one Docker control command with a short, bounded wait. Startup cleanup
 * must never hang application boot if the daemon or socket has become wedged.
 */
function runBoundedDockerCommandWithSpawn(
  args: readonly string[],
  spawnImpl: SandboxSpawn,
): Promise<SandboxDockerCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<SandboxSpawn> | undefined;
    let stdout = '';
    let stderr = '';
    const finish = (result: SandboxDockerCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* Docker control is unavailable; do not leave startup waiting */
      }
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, SANDBOX_DOCKER_COMMAND_TIMEOUT_MS);
    try {
      child = spawnImpl('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
      });
      child.once('error', (err) => {
        finish({ exitCode: null, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut: false });
      });
      child.once('close', (exitCode) => finish({ exitCode, stdout, stderr, timedOut: false }));
    } catch (err) {
      finish({
        exitCode: null,
        stdout,
        stderr: err instanceof Error ? err.message : 'failed to launch docker',
        timedOut: false,
      });
    }
  });
}

function runBoundedDockerCommand(args: readonly string[]): Promise<SandboxDockerCommandResult> {
  return runBoundedDockerCommandWithSpawn(args, spawn);
}

function assertDockerCommandSucceeded(
  action: string,
  result: SandboxDockerCommandResult,
): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail = result.timedOut
    ? 'timed out'
    : result.stderr.trim() || `exit code ${result.exitCode ?? 'unknown'}`;
  throw new Error(`internal sandbox ${action} failed: ${detail}`);
}

function parseContainerIds(stdout: string): string[] {
  const ids = stdout.split(/\r?\n/).filter(Boolean);
  if (!ids.every((id) => /^[a-f0-9]{12,64}$/i.test(id))) {
    throw new Error('internal sandbox cleanup returned an invalid container identifier');
  }
  return ids;
}

/**
 * Remove containers left behind when an app or host crash interrupts a runtime
 * check. Discovery requires both Orvex labels and each ID is label-verified
 * again before removal, so this path cannot act on unrelated containers.
 */
export async function prepareSandboxRuntimeForStartup(
  options: SandboxStartupPreparationOptions = {},
): Promise<SandboxStartupPreparation> {
  const enabled = options.enabled ?? process.env.ORVEX_CODE_EXECUTION === '1';
  if (!enabled) return { enabled: false, removedContainers: 0 };

  const runDockerCommand = options.runDockerCommand ?? runBoundedDockerCommand;
  const listed = await runDockerCommand([
    'ps', '--all', '--quiet', '--filter', 'status=exited',
    '--filter', `label=${ORVEX_MANAGED_LABEL}`,
    '--filter', `label=${ORVEX_RUNTIME_LABEL}`,
  ]);
  assertDockerCommandSucceeded('orphan discovery', listed);

  const ids = parseContainerIds(listed.stdout);
  for (const id of ids) {
    const labels = await runDockerCommand([
      'inspect', '--format', '{{printf "%s\\t%s" (index .Config.Labels "orvex.managed") (index .Config.Labels "orvex.runtime-verify")}}', id,
    ]);
    assertDockerCommandSucceeded(`label verification for ${id}`, labels);
    if (labels.stdout.trim() !== 'true\ttrue') {
      throw new Error(`internal sandbox cleanup refused container ${id}: required Orvex labels changed`);
    }
    const removed = await runDockerCommand(['rm', '--force', id]);
    assertDockerCommandSucceeded(`orphan removal for ${id}`, removed);
  }

  const readiness = await (options.checkReadiness ?? (() => checkSandboxRuntimeReadiness()))();
  if (!readiness.ready) {
    throw new Error(`internal sandbox readiness failed: ${readiness.reason}`);
  }
  return { enabled: true, removedContainers: ids.length, image: readiness.image };
}

/** Production entry point. Docker is only invoked through this bounded runner. */
export async function runInSandbox(opts: SandboxRunOptions): Promise<SandboxResult> {
  return runInSandboxWithSpawnForTest(opts, spawn);
}

/** Test seam for Docker argv and lifecycle behavior; production never supplies a spawn override. */
export async function runInSandboxWithSpawnForTest(
  opts: SandboxRunOptions,
  spawnImpl: SandboxSpawn,
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const name = `orvex-rv-${randomUUID().slice(0, 12)}`;
  const args = buildSandboxDockerArgs(opts, name);

  try {
    await acquireSlot(opts.signal);
  } catch (err) {
    if (err instanceof SandboxCancelledError) {
      return {
        exitCode: null,
        stdout: '',
        stderr: '[sandbox] cancelled',
        timedOut: false,
        cancelled: true,
        durationMs: 0,
      };
    }
    throw err;
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
  const startedAt = Date.now();
  return await new Promise<SandboxResult>((resolve) => {
    let child: ReturnType<SandboxSpawn>;
    try {
      child = spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      releaseSlot();
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `[sandbox] failed to launch docker: ${(err as Error).message}`,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup: Promise<void> | undefined;
    const cleanupContainer = (killFirst: boolean): Promise<void> => {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        if (killFirst) await waitForDockerCommand(spawnImpl, ['kill', name]);
        // `rm --force` is the final ownership handoff: it removes the named
        // container even if the docker client exited before the cancellation.
        await waitForDockerCommand(spawnImpl, ['rm', '--force', name]);
      })();
      return cleanup;
    };
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      releaseSlot();
      resolve(r);
    };

    const cap = (buf: string, chunk: Buffer) =>
      buf.length >= MAX_CAPTURE_BYTES ? buf : (buf + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);

    child.stdout?.on('data', (c: Buffer) => {
      stdout = cap(stdout, c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = cap(stderr, c);
    });

    const failAndCleanup = (result: SandboxResult, killFirst: boolean) => {
      // Start Docker cleanup before killing the client: a synchronous `close`
      // event must see the in-progress cleanup and cannot release the slot early.
      const cleanupPromise = cleanupContainer(killFirst);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      void cleanupPromise.then(() => finish(result));
    };
    const onAbort = () => {
      failAndCleanup({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[sandbox] cancelled`.trim(),
        timedOut: false,
        cancelled: true,
        durationMs: Date.now() - startedAt,
      }, true);
    };
    timer = setTimeout(() => {
      timedOut = true;
      failAndCleanup({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
        durationMs: Date.now() - startedAt,
      }, true);
    }, timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    child.on('error', (err) => {
      failAndCleanup({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[sandbox] failed to launch docker: ${err.message}`.trim(),
        timedOut,
        durationMs: Date.now() - startedAt,
      }, true);
    });

    child.on('close', (code) => {
      if (cleanup) return;
      finish({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });
  });
}
