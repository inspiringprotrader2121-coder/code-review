import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchRepoSnapshot, type createInstallationOctokit } from '@orvex-review/github';
import { redactSecrets, sanitizeFindingText } from '@orvex-review/review';
import {
  assertWorkdirWithinQuota,
  checkSandboxRuntimeReadiness,
  runInSandbox,
  type SandboxRuntimeReadiness,
} from './sandbox.js';
import { noteActiveCheckoutDir } from './active-reviews.js';

/**
 * Tier-2 execution engine (the TREX equivalent): materialize the PR head, run
 * the repo's OWN verification (install → typecheck/build → tests) inside the
 * hardened Docker sandbox, and return pass/fail + captured logs as evidence.
 *
 * Running the repo's declared scripts — not arbitrary generated code — is the
 * bounded, defensible first capability: it catches build breaks, type errors,
 * and newly-failing tests that a static review can't see, and attaches the real
 * output so a human (or a downstream agent) can confirm rather than trust.
 *
 * Gated: only runs when the tenant's plan allows codeExecution AND
 * ORVEX_CODE_EXECUTION=1. Off by default.
 */

export interface RuntimeStep {
  name: string;
  command: string;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  output: string;
  /** true when the SAME step also fails at the base commit — pre-existing,
   *  NOT introduced by this PR (base-vs-head comparison) */
  preExisting?: boolean;
}

export interface RuntimeVerifyResult {
  ran: boolean;
  skippedReason?: string;
  steps: RuntimeStep[];
  /** the same steps run at the BASE commit (only present when head had failures
   *  and a base comparison was possible) */
  baseSteps?: RuntimeStep[];
}

export interface RuntimeVerifyDependencies {
  fetchSnapshot: typeof fetchRepoSnapshot;
  runSandbox: typeof runInSandbox;
  checkSandboxRuntimeReadiness: (signal?: AbortSignal) => Promise<SandboxRuntimeReadiness>;
}

export interface RuntimeVerifyOptions {
  baseSha?: string;
  /** Owning review's cancellation signal, forwarded to every sandbox run. */
  signal?: AbortSignal;
  /** Test seam for lifecycle coverage without Docker or GitHub calls. */
  dependencies?: Partial<RuntimeVerifyDependencies>;
}

const defaultRuntimeVerifyDependencies: RuntimeVerifyDependencies = {
  fetchSnapshot: fetchRepoSnapshot,
  runSandbox: runInSandbox,
  checkSandboxRuntimeReadiness: (signal) => checkSandboxRuntimeReadiness({ signal }),
};

function positiveEnvNumber(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}
const STEP_TIMEOUT_MS = positiveEnvNumber('ORVEX_SANDBOX_STEP_TIMEOUT_MS', 240_000, 900_000);
const INSTALL_TIMEOUT_MS = positiveEnvNumber('ORVEX_SANDBOX_INSTALL_TIMEOUT_MS', 300_000, 900_000);

// Package managers and dependency caches must be baked into the reviewed,
// digest-pinned runtime image. Customer lockfiles never receive network egress.
const TOOLS_PREFIX = '/work/.orvex-tools';
const TOOLS_PATH = `export NPM_CONFIG_PREFIX=${TOOLS_PREFIX} && export PATH=${TOOLS_PREFIX}/bin:$PATH`;

function detectPackageManager(files: Map<string, string>): { pm: string; installCmd: string } {
  // --ignore-scripts is CRITICAL: it stops package lifecycle scripts (pre/post
  // install, prepare) from running arbitrary code. Offline mode is equally
  // critical: an attacker-controlled lockfile or .npmrc cannot reach arbitrary
  // internet/private endpoints from the runtime boundary.
  if (files.has('pnpm-lock.yaml')) {
    return {
      pm: 'pnpm',
      installCmd: `${TOOLS_PATH} && pnpm install --offline --frozen-lockfile --ignore-scripts`,
    };
  }
  if (files.has('yarn.lock')) {
    return {
      pm: 'yarn',
      installCmd: `${TOOLS_PATH} && yarn install --offline --frozen-lockfile --ignore-scripts`,
    };
  }
  return { pm: 'npm', installCmd: 'npm ci --offline --ignore-scripts' };
}

/** Verification steps declared by the project (typecheck/build + test). */
function detectSteps(pkgJson: string, pm: string): Array<{ name: string; command: string }> {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(pkgJson).scripts ?? {}) as Record<string, string>;
  } catch {
    return [];
  }
  // npm ships in the image; pnpm/yarn live under /work/.orvex-tools (see install)
  const prefix = pm === 'npm' ? '' : `${TOOLS_PATH} && `;
  const run = (s: string) => `${prefix}${pm} run ${s}`;
  const steps: Array<{ name: string; command: string }> = [];
  if (scripts.typecheck) steps.push({ name: 'typecheck', command: run('typecheck') });
  else if (scripts.build) steps.push({ name: 'build', command: run('build') });
  if (scripts.test) steps.push({ name: 'test', command: run('test') });
  return steps;
}

export async function runtimeVerify(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  sha: string,
  opts: RuntimeVerifyOptions = {},
): Promise<RuntimeVerifyResult> {
  const dependencies = { ...defaultRuntimeVerifyDependencies, ...opts.dependencies };
  if (opts.signal?.aborted) return cancelledResult();
  // Perform the fail-closed host/image preflight before fetching a checkout or
  // constructing a workdir. The verifier must never fall back to a mutable
  // image or leave Docker to pull one as part of a customer review.
  const readiness = await dependencies.checkSandboxRuntimeReadiness(opts.signal);
  if (!readiness.ready) {
    return { ran: false, skippedReason: `sandbox unavailable: ${readiness.reason}`, steps: [] };
  }
  if (opts.signal?.aborted) return cancelledResult();
  const head = await runStepsAtSha(octokit, owner, repo, sha, readiness.image, opts.signal, dependencies);
  // BASE-VS-HEAD: a HEAD-only run blames the PR for failures that already exist
  // on main. When the head fails and we know the base, run the SAME steps at
  // base and mark each failure that reproduces there as pre-existing. (Skipped
  // when head is green — a green head needs no comparison, and base runs cost
  // real time.)
  if (!head.ran || head.steps.every((s) => s.ok) || !opts.baseSha || opts.baseSha === sha) {
    return head;
  }
  if (opts.signal?.aborted) return cancelledResult();
  const base = await runStepsAtSha(octokit, owner, repo, opts.baseSha, readiness.image, opts.signal, dependencies);
  if (base.ran) {
    markPreExistingFailures(head, base);
  }
  return head;
}

/** Apply the base-vs-head classification independently of Docker/GitHub I/O so
 * the regression logic is directly testable. A step is pre-existing only when
 * the same named step fails at both revisions. */
export function markPreExistingFailures(head: RuntimeVerifyResult, base: RuntimeVerifyResult): void {
  head.baseSteps = base.steps;
  for (const step of head.steps) {
    const atBase = base.steps.find((candidate) => candidate.name === step.name);
    step.preExisting = !step.ok && Boolean(atBase && !atBase.ok);
  }
}

/** Materialize the repo at `sha` and run its declared verification steps. */
async function runStepsAtSha(
  octokit: ReturnType<typeof createInstallationOctokit>,
  owner: string,
  repo: string,
  sha: string,
  image: string,
  signal: AbortSignal | undefined,
  dependencies: RuntimeVerifyDependencies,
): Promise<RuntimeVerifyResult> {
  if (signal?.aborted) return cancelledResult();
  // 1) materialize the repo at head into an isolated temp dir
  let snapshot: Map<string, string>;
  try {
    snapshot = await dependencies.fetchSnapshot(octokit, owner, repo, sha, { maxFileBytes: 1_000_000, maxTotalBytes: 200_000_000 });
  } catch (err) {
    return { ran: false, skippedReason: `snapshot failed: ${(err as Error).message}`, steps: [] };
  }
  if (signal?.aborted) return cancelledResult();
  const pkgJson = snapshot.get('package.json');
  if (!pkgJson) return { ran: false, skippedReason: 'no package.json (non-Node project)', steps: [] };

  const { pm, installCmd } = detectPackageManager(snapshot);
  const steps = detectSteps(pkgJson, pm);
  if (steps.length === 0) return { ran: false, skippedReason: 'no typecheck/build/test scripts', steps: [] };

  // Prefix kept DISTINCT from the sandbox container name (`orvex-rv-…`) so the
  // abandoned-checkout sweeper can never confuse a live container's mount with
  // a stale runtime-verify workdir.
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-rverify-'));
  noteActiveCheckoutDir(workdir);
  try {
    for (const [rel, content] of snapshot) {
      const dest = path.join(workdir, rel);
      // guard against path traversal from a crafted tar entry
      if (!dest.startsWith(workdir + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    // Prefer 770 owned by the container uid when chown is allowed; fall back to
    // 777 only when we cannot transfer ownership (non-root host process).
    try {
      fs.chownSync(workdir, 1000, 1000);
      fs.chmodSync(workdir, 0o770);
    } catch {
      fs.chmodSync(workdir, 0o777);
    }

    // 2) materialize deps strictly from the immutable image's package cache.
    const install = await dependencies.runSandbox({
      workdir,
      image,
      command: installCmd,
      network: 'none',
      timeoutMs: INSTALL_TIMEOUT_MS,
      signal,
    });
    if (install.cancelled || signal?.aborted) return cancelledResult();
    try {
      assertWorkdirWithinQuota(workdir);
    } catch (err) {
      return {
        ran: true,
        steps: [
          {
            name: 'install',
            command: installCmd,
            ok: false,
            timedOut: false,
            durationMs: install.durationMs,
            output: tail((err as Error).message),
          },
        ],
      };
    }
    if (install.exitCode !== 0) {
      return {
        ran: true,
        steps: [
          {
            name: 'install',
            command: installCmd,
            ok: false,
            timedOut: install.timedOut,
            durationMs: install.durationMs,
            output: tail(install.stderr || install.stdout),
          },
        ],
      };
    }

    // 3) run each verification step network-ISOLATED
    const results: RuntimeStep[] = [];
    for (const step of steps) {
      try {
        assertWorkdirWithinQuota(workdir);
      } catch (err) {
        results.push({
          name: step.name,
          command: step.command,
          ok: false,
          timedOut: false,
          durationMs: 0,
          output: tail((err as Error).message),
        });
        break;
      }
      const r = await dependencies.runSandbox({
        workdir,
        image,
        command: step.command,
        network: 'none',
        timeoutMs: STEP_TIMEOUT_MS,
        signal,
      });
      if (r.cancelled || signal?.aborted) return cancelledResult();
      results.push({
        name: step.name,
        command: step.command,
        ok: r.exitCode === 0 && !r.timedOut,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        output: tail(r.stdout + (r.stderr ? `\n${r.stderr}` : '')),
      });
      try {
        assertWorkdirWithinQuota(workdir);
      } catch (err) {
        results.push({
          name: `${step.name}-disk`,
          command: 'workdir quota',
          ok: false,
          timedOut: false,
          durationMs: 0,
          output: tail((err as Error).message),
        });
        break;
      }
    }
    return { ran: true, steps: results };
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function cancelledResult(): RuntimeVerifyResult {
  return { ran: false, skippedReason: 'runtime verification cancelled', steps: [] };
}

/** Last ~2k chars of output — the failing tail is what matters as evidence. */
function tail(s: string, n = 2_000): string {
  // Redact secrets: a repo's build/test script can print env/secrets, and this
  // tail is posted into a (possibly public) PR comment as evidence.
  const t = redactSecrets(s.trimEnd());
  return t.length > n ? `…\n${t.slice(-n)}` : t;
}

/** Make command output safe to embed inside a markdown ``` fence. */
function fenceSafeOutput(s: string): string {
  return sanitizeFindingText(redactSecrets(s))
    .replace(/`/g, "'")
    .replace(/\u0000/g, '');
}

/** Render a runtime-verification result as a PR comment body (evidence attached). */
export function formatRuntimeEvidence(result: RuntimeVerifyResult): string | null {
  if (!result.ran) return null;
  const lines: string[] = ['### 🧪 Orvex runtime verification'];
  const failed = result.steps.filter((s) => !s.ok);
  const newFailures = failed.filter((s) => !s.preExisting);
  if (failed.length === 0) {
    // Name the steps that ACTUALLY ran — "install, typecheck, and tests all
    // passed" was a lie on repos with only a build script or no tests.
    lines.push(`✅ Ran the change in an isolated sandbox — ${result.steps.map((s) => s.name).join(' + ')} passed.`);
  } else if (newFailures.length === 0) {
    lines.push(
      `⚠️ Ran the change in an isolated sandbox — ${failed.length} step(s) failed, but the SAME step(s) fail at the base commit: pre-existing, NOT introduced by this PR.`,
    );
  } else {
    lines.push(
      `❌ Ran the change in an isolated sandbox — **${newFailures.length} step(s) failed** and pass at the base commit — likely introduced by this PR.` +
        (failed.length > newFailures.length
          ? ` (${failed.length - newFailures.length} more failure(s) also fail at base — pre-existing.)`
          : ''),
    );
  }
  for (const s of result.steps) {
    const status = s.timedOut ? '⏱️ timed out' : s.ok ? '✅ passed' : '❌ failed';
    const pre = s.preExisting ? ' — also fails at base (pre-existing)' : '';
    const safeCmd = fenceSafeOutput(s.command).replace(/\n/g, ' ');
    lines.push(`\n**${sanitizeFindingText(s.name)}** — \`${safeCmd}\` — ${status}${pre} (${Math.round(s.durationMs / 1000)}s)`);
    if (!s.ok && s.output) lines.push('```\n' + fenceSafeOutput(s.output) + '\n```');
  }
  return lines.join('\n');
}
