import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  ORVEX_MANAGED_LABEL,
  ORVEX_OWNER_TOKEN_LABEL,
  ORVEX_RUNTIME_LABEL,
  type SandboxDockerCommandResult,
  type SandboxStartupPreparation,
  type SandboxStartupPreparationOptions,
} from './contracts.js';
import { runBoundedDockerCommand } from './docker-control.js';
import { checkSandboxRuntimeReadiness } from './readiness.js';

function assertDockerCommandSucceeded(action: string, result: SandboxDockerCommandResult): void {
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

function defaultIsProcessAlive(pid: number): boolean {
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

function ownerTokenIsActive(
  runtime: SandboxStartupPreparationOptions['runtime'],
  pid: number,
  token: string,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  if (!isProcessAlive(pid) || !/^[a-f0-9-]{36}$/.test(token)) return false;
  const root = runtime?.slotDirectory ?? path.join(os.tmpdir(), 'orvex-sandbox-slots-v1');
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^slot-\d+$/.test(entry.name)) continue;
      try {
        const owner = JSON.parse(
          fs.readFileSync(path.join(root, entry.name, 'owner.json'), 'utf8'),
        ) as { pid?: number; token?: string; processIdentity?: string };
        if (owner.pid !== pid || owner.token !== token) continue;
        const identity = processIdentity(pid);
        return identity === null || owner.processIdentity === identity;
      } catch {
        // A malformed lease cannot prove ownership.
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Safely reclaim only the app's doubly-labelled containers before workers start. */
export async function prepareSandboxRuntimeForStartup(
  options: SandboxStartupPreparationOptions = {},
): Promise<SandboxStartupPreparation> {
  const runtime = options.runtime ?? DEFAULT_SANDBOX_RUNTIME_OPTIONS;
  const enabled = options.enabled ?? runtime.codeExecutionEnabled;
  if (!enabled) return { enabled: false, removedContainers: 0 };
  const runDockerCommand = options.runDockerCommand ?? runBoundedDockerCommand;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const readiness = await (
    options.checkReadiness ?? (() => checkSandboxRuntimeReadiness({ runtime }))
  )();
  if (!readiness.ready) throw new Error(`internal sandbox readiness failed: ${readiness.reason}`);
  const listed = await runDockerCommand([
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=${ORVEX_MANAGED_LABEL}`,
    '--filter',
    `label=${ORVEX_RUNTIME_LABEL}`,
  ]);
  assertDockerCommandSucceeded('orphan discovery', listed);
  const ids = parseContainerIds(listed.stdout);
  let removedContainers = 0;
  for (const id of ids) {
    const labels = await runDockerCommand([
      'inspect',
      '--format',
      `{{printf "%s\\t%s\\t%s\\t%s" (index .Config.Labels "orvex.managed") (index .Config.Labels "orvex.runtime-verify") (index .Config.Labels "orvex.owner-pid") (index .Config.Labels "${ORVEX_OWNER_TOKEN_LABEL}")}}`,
      id,
    ]);
    assertDockerCommandSucceeded(`label verification for ${id}`, labels);
    const [managed, runtimeLabel, ownerPidText, ownerToken = ''] = labels.stdout.trim().split('\t');
    if (managed !== 'true' || runtimeLabel !== 'true') {
      throw new Error(
        `internal sandbox cleanup refused container ${id}: required Orvex labels changed`,
      );
    }
    const ownerPid = Number(ownerPidText);
    if (
      Number.isSafeInteger(ownerPid) &&
      ownerPid > 0 &&
      ownerTokenIsActive(runtime, ownerPid, ownerToken, isProcessAlive)
    )
      continue;
    const removed = await runDockerCommand(['rm', '--force', id]);
    assertDockerCommandSucceeded(`orphan removal for ${id}`, removed);
    removedContainers++;
  }
  return { enabled: true, removedContainers, image: readiness.image };
}
