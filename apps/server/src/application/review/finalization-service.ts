import { shouldRequeueAdmissionFailure } from '@orvex-review/review';
import type { FailureNotice } from './admission-service.js';
import type { AdmittedReview, ProcessResult } from './types.js';
import fs from 'node:fs';

export async function runPostPublicationStep(
  label: string,
  action: () => unknown | Promise<unknown>,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    console.error(
      `[worker] post-publication ${label} failed (non-fatal):`,
      (error as Error).message,
    );
    return false;
  }
}

export interface FinalizationServiceDependencies {
  now?: () => number;
  postFailureNotice: FailureNotice;
}

/** Settles reservation state after computation, without re-running publication. */
export class FinalizationService {
  constructor(private readonly dependencies: FinalizationServiceDependencies) {}

  cleanupCheckout(directory: string | null): void {
    if (!directory) return;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Temporary checkout cleanup is best-effort.
    }
  }

  cleanupCancellation(input: {
    poll: ReturnType<typeof setInterval>;
    parentSignal?: AbortSignal;
    listener: () => void;
  }): void {
    clearInterval(input.poll);
    input.parentSignal?.removeEventListener('abort', input.listener);
  }

  async complete(review: AdmittedReview, result: ProcessResult): Promise<ProcessResult> {
    const { job, config, runId, startedAt, plan } = review;
    const deliveredDeep = Boolean(job.deep) && result.deepLensesRan === true;
    const failureReason = result.skipReason
      ? `review did not complete: ${result.skipReason}`
      : result.incompleteReason;
    try {
      config.store.completeReviewRun(runId, {
        status: failureReason ? 'failed' : 'completed',
        skipReason: result.skipReason,
        error: failureReason,
        durationMs: (this.dependencies.now?.() ?? Date.now()) - startedAt,
        findingsNew: result.newCount,
        findingsFixed: result.fixedCount,
        findingsOpen: result.findingCount,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        newFindings: result.newFindings,
        deep: deliveredDeep,
      });
      if (failureReason) {
        config.store.refundOverageCredits(runId, `refund: ${failureReason.slice(0, 160)}`);
      } else if (
        Boolean(job.deep) &&
        !deliveredDeep &&
        plan.overageCentsPerReview !== null &&
        config.store.overageDebitNetCents(runId) > 0
      ) {
        config.store.reconcileOverageDebit(
          runId,
          plan.overageCentsPerReview,
          'reconcile: deep lenses did not run',
        );
      }
    } catch (error) {
      if (!result.published) throw error;
      console.error(
        '[worker] post-publication review-run accounting failed (non-fatal):',
        (error as Error).message,
      );
    }
    return result;
  }

  async fail(review: AdmittedReview, error: unknown): Promise<never> {
    const { job, config, runId, startedAt } = review;
    const message = error instanceof Error ? error.message : String(error);
    config.store.completeReviewRun(runId, {
      status: 'failed',
      error: message,
      durationMs: (this.dependencies.now?.() ?? Date.now()) - startedAt,
    });
    config.store.refundOverageCredits(runId, `refund: failed review (${message.slice(0, 80)})`);
    if (
      !shouldRequeueAdmissionFailure(message, job.attempts ?? 0) &&
      config.store.countRecentFailedRuns({
        installationId: job.installationId,
        owner: job.owner,
        repo: job.repo,
        pr: job.pr,
      }) === 1
    ) {
      await this.dependencies.postFailureNotice(config, job, message);
    }
    throw error;
  }
}
