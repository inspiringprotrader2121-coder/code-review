import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
 *
 * This gates untrusted execution behind a small, auditable surface. It is OFF by
 * default (plan + ORVEX_CODE_EXECUTION) — turning it on for public/untrusted
 * repos should follow a review of these flags.
 */

export interface SandboxRunOptions {
  /** absolute host path mounted read-write at /work */
  workdir: string;
  /** container image (must be present locally or pullable before network-off runs) */
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
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_CAPTURE_BYTES = 64_000; // keep evidence readable and bounded

// Global cap on concurrent sandbox containers across ALL jobs/tenants — the
// per-container limits bound one container; this bounds the fleet so a burst of
// hostile PRs can't spawn unbounded containers and pin the host.
const MAX_SANDBOXES = Math.max(1, Number(process.env.ORVEX_MAX_SANDBOXES ?? 2));
let activeSandboxes = 0;
const waiters: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (activeSandboxes < MAX_SANDBOXES) {
    activeSandboxes++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  activeSandboxes++;
}
function releaseSlot(): void {
  activeSandboxes--;
  waiters.shift()?.();
}

export async function runInSandbox(opts: SandboxRunOptions): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const name = `orvex-rv-${randomUUID().slice(0, 12)}`;
  const args = [
    'run',
    '--rm',
    '--name',
    name,
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
    `${opts.workdir}:/work:rw`,
    '-w',
    '/work',
  ];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(opts.image, 'sh', '-c', opts.command);

  await acquireSlot();
  const startedAt = Date.now();
  return await new Promise<SandboxResult>((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      releaseSlot();
      resolve(r);
    };

    const cap = (buf: string, chunk: Buffer) =>
      buf.length >= MAX_CAPTURE_BYTES ? buf : (buf + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);

    child.stdout.on('data', (c: Buffer) => {
      stdout = cap(stdout, c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = cap(stderr, c);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the CONTAINER (not just the docker CLI, which is only a client): a
      // process ignoring signals would otherwise outlive the timeout. `docker
      // kill` by name stops it; --rm then reaps it. Also kill the CLI so the
      // close handler fires.
      spawn('docker', ['kill', name], { stdio: 'ignore' }).on('error', () => {});
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[sandbox] failed to launch docker: ${err.message}`.trim(),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });
  });
}
