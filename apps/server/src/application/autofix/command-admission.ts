import { planFeatures } from '@orvex-review/tenants';
import type { AutofixDependencies, AutofixRuntime } from './contracts.js';
import type { ReviewJobPayload } from '@orvex-review/queue';

export function commandBlockedMessage(
  reason: string | null,
  runtime: AutofixRuntime,
): string | null {
  if (!reason) return null;
  if (reason === 'cost_capped') {
    return 'Orvex has paused interactive commands for this account because the monthly cost safety ceiling was reached — contact support if you need this raised.';
  }
  if (reason === 'command_rate_limited' || reason === 'concurrency_limited') {
    return `Orvex interactive commands are capped at ${runtime.autofix.commandsPerHour}/hour per account to prevent runaway cost — try again shortly.`;
  }
  return `Orvex could not start this command (${reason}). Try again shortly or check the dashboard.`;
}

export function commandBlockReason(
  dependencies: AutofixDependencies,
  owner: string,
  planId: string,
  tenantId: string | undefined,
  runtime: AutofixRuntime,
): string | null {
  if (
    planId !== 'enterprise' &&
    dependencies.store.countAccountCommandRuns(owner, 3_600_000) >= runtime.autofix.commandsPerHour
  ) {
    return 'command_rate_limited';
  }
  // The command reservation is COGS-only: it must never spend included PR quota.
  return dependencies.commandLimitReason(owner, planFeatures(planId), tenantId);
}

export function commandPrecheck(
  dependencies: AutofixDependencies,
  owner: string,
  planId: string,
  tenantId: string | undefined,
  runtime: AutofixRuntime,
): string | null {
  return commandBlockedMessage(
    commandBlockReason(dependencies, owner, planId, tenantId, runtime),
    runtime,
  );
}

/** Atomically reserves one paid command before any model call. */
export function reserveCommandRun(
  dependencies: AutofixDependencies,
  job: ReviewJobPayload,
  kind: string,
  planId: string,
  runtime: AutofixRuntime,
): string | null {
  const reserved = dependencies.store.tryReserveReviewRun(
    {
      tenantId: job.tenantId,
      installationId: job.installationId,
      owner: job.owner,
      repo: job.repo,
      pr: job.pr,
      headSha: job.headSha,
      action: `cmd:${kind}`,
    },
    () => commandBlockReason(dependencies, job.owner, planId, job.tenantId, runtime),
  );
  return reserved.ok ? reserved.runId : null;
}

export function completeCommandRun(
  dependencies: AutofixDependencies,
  runId: string | null,
  startedAt: number,
  status: 'completed' | 'failed' | 'skipped',
  error?: string,
): void {
  if (!runId) return;
  dependencies.store.completeReviewRun(runId, {
    status,
    error,
    durationMs: Date.now() - startedAt,
  });
}
