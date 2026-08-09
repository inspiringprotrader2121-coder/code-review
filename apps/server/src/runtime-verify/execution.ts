import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { createInstallationOctokit } from '@orvex-review/github';
import { assertWorkdirWithinQuota } from '../sandbox.js';
import { noteActiveCheckoutDir } from '../active-reviews.js';
import type {
  RuntimeStep,
  RuntimeVerifyDependencies,
  RuntimeVerifyOptions,
  RuntimeVerifyResult,
} from './contracts.js';
import { defaultRuntimeVerifyDependencies } from './dependencies.js';
import { tailRuntimeOutput } from './evidence.js';
import {
  detectPackageManager,
  detectSteps,
  isOfflineCacheMiss,
  materializeSnapshot,
} from './snapshot.js';

export function cancelledRuntimeVerifyResult(): RuntimeVerifyResult {
  return { ran: false, skippedReason: 'runtime verification cancelled', steps: [] };
}

/** Compare matching named verification steps at head and base. */
export function markPreExistingFailures(
  head: RuntimeVerifyResult,
  base: RuntimeVerifyResult,
): void {
  head.baseSteps = base.steps;
  for (const step of head.steps) {
    const atBase = base.steps.find((candidate) => candidate.name === step.name);
    step.preExisting = !step.ok && Boolean(atBase && !atBase.ok);
  }
}

/**
 * Run the declared build/test scripts from an immutable GitHub snapshot in the
 * already-validated sandbox runtime. No caller-supplied host config reaches
 * the checkout or container.
 */
export async function runtimeVerify(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  sha: string,
  options: RuntimeVerifyOptions = {},
): Promise<RuntimeVerifyResult> {
  const dependencies: RuntimeVerifyDependencies = Object.freeze({
    ...defaultRuntimeVerifyDependencies,
    ...options.dependencies,
  });
  if (options.signal?.aborted) return cancelledRuntimeVerifyResult();
  const readiness = await dependencies.checkSandboxRuntimeReadiness(options.signal);
  if (!readiness.ready) {
    return { ran: false, skippedReason: `sandbox unavailable: ${readiness.reason}`, steps: [] };
  }
  if (options.signal?.aborted) return cancelledRuntimeVerifyResult();
  const head = await runStepsAtSha(
    octokit,
    owner,
    repo,
    sha,
    readiness.image,
    options.signal,
    dependencies,
  );
  if (
    !head.ran ||
    head.steps.every((step) => step.ok) ||
    !options.baseSha ||
    options.baseSha === sha
  ) {
    return head;
  }
  if (options.signal?.aborted) return cancelledRuntimeVerifyResult();
  const base = await runStepsAtSha(
    octokit,
    owner,
    repo,
    options.baseSha,
    readiness.image,
    options.signal,
    dependencies,
  );
  if (base.ran) markPreExistingFailures(head, base);
  return head;
}

async function runStepsAtSha(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  sha: string,
  image: string,
  signal: AbortSignal | undefined,
  dependencies: RuntimeVerifyDependencies,
): Promise<RuntimeVerifyResult> {
  if (signal?.aborted) return cancelledRuntimeVerifyResult();
  let snapshot: Map<string, string>;
  try {
    snapshot = await dependencies.fetchSnapshot(octokit, owner, repo, sha, {
      maxFileBytes: 1_000_000,
      maxTotalBytes: 200_000_000,
    });
  } catch (error) {
    return { ran: false, skippedReason: `snapshot failed: ${(error as Error).message}`, steps: [] };
  }
  if (signal?.aborted) return cancelledRuntimeVerifyResult();
  const packageJson = snapshot.get('package.json');
  if (!packageJson)
    return { ran: false, skippedReason: 'no package.json (non-Node project)', steps: [] };

  const { pm, installCmd } = detectPackageManager(snapshot);
  const steps = detectSteps(packageJson, pm);
  if (steps.length === 0)
    return { ran: false, skippedReason: 'no typecheck/build/test scripts', steps: [] };

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-rverify-'));
  noteActiveCheckoutDir(workdir);
  try {
    try {
      materializeSnapshot(workdir, snapshot, dependencies.maxSnapshotFiles);
    } catch (error) {
      return {
        ran: false,
        skippedReason: `sandbox snapshot rejected: ${(error as Error).message}`,
        steps: [],
      };
    }
    fs.chmodSync(workdir, 0o700);

    const install = await dependencies.runSandbox({
      workdir,
      image,
      command: installCmd,
      timeoutMs: dependencies.installTimeoutMs,
      signal,
    });
    if (install.cancelled || signal?.aborted) return cancelledRuntimeVerifyResult();
    try {
      assertWorkdirWithinQuota(workdir, dependencies.workdirMaxBytes);
    } catch (error) {
      return failedInstallForQuota(installCmd, install.durationMs, error);
    }
    if (install.exitCode !== 0) {
      const output = install.stderr || install.stdout;
      if (!install.timedOut && isOfflineCacheMiss(output)) {
        return {
          ran: false,
          skippedReason: 'sandbox dependency cache does not contain this lockfile',
          steps: [],
        };
      }
      return {
        ran: true,
        steps: [
          {
            name: 'install',
            command: installCmd,
            ok: false,
            timedOut: install.timedOut,
            durationMs: install.durationMs,
            output: tailRuntimeOutput(output),
          },
        ],
      };
    }

    const results: RuntimeStep[] = [];
    for (const step of steps) {
      try {
        assertWorkdirWithinQuota(workdir, dependencies.workdirMaxBytes);
      } catch (error) {
        results.push(quotaFailure(step.name, step.command, error));
        break;
      }
      const result = await dependencies.runSandbox({
        workdir,
        image,
        command: step.command,
        timeoutMs: dependencies.stepTimeoutMs,
        signal,
      });
      if (result.cancelled || signal?.aborted) return cancelledRuntimeVerifyResult();
      results.push({
        name: step.name,
        command: step.command,
        ok: result.exitCode === 0 && !result.timedOut,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        output: tailRuntimeOutput(result.stdout + (result.stderr ? `\n${result.stderr}` : '')),
      });
      try {
        assertWorkdirWithinQuota(workdir, dependencies.workdirMaxBytes);
      } catch (error) {
        results.push(quotaFailure(`${step.name}-disk`, 'workdir quota', error));
        break;
      }
    }
    return { ran: true, steps: results };
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function failedInstallForQuota(
  command: string,
  durationMs: number,
  error: unknown,
): RuntimeVerifyResult {
  return {
    ran: true,
    steps: [
      {
        name: 'install',
        command,
        ok: false,
        timedOut: false,
        durationMs,
        output: tailRuntimeOutput((error as Error).message),
      },
    ],
  };
}

function quotaFailure(name: string, command: string, error: unknown): RuntimeStep {
  return {
    name,
    command,
    ok: false,
    timedOut: false,
    durationMs: 0,
    output: tailRuntimeOutput((error as Error).message),
  };
}
