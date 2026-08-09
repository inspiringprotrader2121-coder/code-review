import {
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  ORVEX_MANAGED_LABEL,
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

/** Safely reclaim only the app's doubly-labelled containers before workers start. */
export async function prepareSandboxRuntimeForStartup(
  options: SandboxStartupPreparationOptions = {},
): Promise<SandboxStartupPreparation> {
  const runtime = options.runtime ?? DEFAULT_SANDBOX_RUNTIME_OPTIONS;
  const enabled = options.enabled ?? runtime.codeExecutionEnabled;
  if (!enabled) return { enabled: false, removedContainers: 0 };
  const runDockerCommand = options.runDockerCommand ?? runBoundedDockerCommand;
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
  for (const id of ids) {
    const labels = await runDockerCommand([
      'inspect',
      '--format',
      '{{printf "%s\\t%s" (index .Config.Labels "orvex.managed") (index .Config.Labels "orvex.runtime-verify")}}',
      id,
    ]);
    assertDockerCommandSucceeded(`label verification for ${id}`, labels);
    if (labels.stdout.trim() !== 'true\ttrue') {
      throw new Error(
        `internal sandbox cleanup refused container ${id}: required Orvex labels changed`,
      );
    }
    const removed = await runDockerCommand(['rm', '--force', id]);
    assertDockerCommandSucceeded(`orphan removal for ${id}`, removed);
  }
  return { enabled: true, removedContainers: ids.length, image: readiness.image };
}
