import { isPrStillOpen } from '@orvex-review/github';
import { runPostPublicationStep } from '../finalization-service.js';
import type { ArtifactPublisher, PublicationInput, PublicationResult } from './contracts.js';
import { publishCheckRun } from './check-run.js';
import { createClosedPrResult, createPublishedResult } from './result.js';
import { publishReviewOutput } from './review-output.js';
import { publishRuntimeEvidence } from './runtime-evidence.js';
import { serializeReviewState } from './review-state.js';

export async function publishReview(
  publisher: ArtifactPublisher,
  input: PublicationInput,
): Promise<PublicationResult> {
  if (!input.runId) throw new Error('durable publication requires a review run and repository');
  const scope = { tenantId: input.tenantId, runId: input.runId };
  if (!input.config.store.heartbeatReviewRun(input.runId)) input.cancelForOwnershipLoss();
  if (input.ownershipLost()) {
    throw new Error('review run ownership lost before publication; discarding this worker result');
  }
  if (input.config.leaseValid && !(await input.config.leaseValid())) {
    throw new Error('review lease lost before publication; discarding this worker result');
  }
  if (input.signal.aborted || !(await isPrStillOpen(input.octokit, input.ref))) {
    if (input.ownershipLost()) {
      throw new Error(
        'review run ownership lost before publication; discarding this worker result',
      );
    }
    console.log(
      `[worker] PR #${input.number} closed before publication — discarding results, not posting`,
    );
    return createClosedPrResult(input);
  }

  const output = await publishReviewOutput(publisher, input, scope);
  const { state, finalFindings } = serializeReviewState(input, output.commentIdMap);
  await runPostPublicationStep('state persistence', () => input.config.store.saveState(state));
  const openCount = finalFindings.filter((finding) => finding.status === 'open').length;
  await runPostPublicationStep('dashboard state update', () =>
    input.config.store.markReviewedNow(
      input.installationId,
      `${input.owner}/${input.repo}`,
      input.number,
      openCount,
    ),
  );
  await runPostPublicationStep('check run publication', () =>
    publishCheckRun(publisher, input, scope, finalFindings),
  );
  await runPostPublicationStep('runtime-evidence publication', () =>
    publishRuntimeEvidence(publisher, input, scope),
  );

  const { stats } = input.findings;
  console.log(
    `[worker] done PR #${input.number}: ${stats.newCount} new, ${stats.fixedCount} fixed, ${stats.openCount} open`,
  );
  const result = createPublishedResult(input, output.reviewId);
  if ((result.inputTokens ?? 0) + (result.outputTokens ?? 0) > 0) {
    const mix = input.plan.modelTier === 'hybrid' ? ' (hybrid: MiniMax+GLM)' : '';
    console.log(
      `[worker] PR #${input.number} usage${mix}: ${result.inputTokens} in + ${result.outputTokens} out ≈ $${result.costUsd!.toFixed(4)}`,
    );
  }
  return result;
}
