import { isPrStillOpen } from '@orvex-review/github';
import { formatRuntimeEvidence, runtimeVerify } from '../../../runtime-verify.js';
import type { ArtifactPublisher, PublicationInput } from './contracts.js';

export async function mayPublishRuntimeEvidence(
  signal: AbortSignal,
  leaseValid: (() => boolean | Promise<boolean>) | undefined,
  isOpen: () => Promise<boolean>,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (leaseValid && !(await leaseValid())) return false;
  if (signal.aborted) return false;
  try {
    return (await isOpen()) && !signal.aborted;
  } catch {
    return false;
  }
}

export async function publishRuntimeEvidence(
  publisher: ArtifactPublisher,
  input: PublicationInput,
  scope: { tenantId: string; runId: string },
): Promise<void> {
  const { config, plan, octokit, owner, repo, number, effectiveSha, pr, signal, ref } = input;
  if (!plan.codeExecution || !config.sandboxRuntime?.codeExecutionEnabled) return;
  if (!config.runtimeVerifyDependencies) {
    throw new Error('runtime verification requires injected sandbox dependencies');
  }
  console.log(`[worker] tier-2 runtime verify (plan=${plan.id}) PR #${number}…`);
  const result = await runtimeVerify(octokit, owner, repo, effectiveSha, {
    baseSha: pr.baseSha,
    signal,
    dependencies: config.runtimeVerifyDependencies,
  });
  const evidence = formatRuntimeEvidence(result);
  if (!evidence) {
    console.log(`[worker] tier-2 runtime verify skipped: ${result.skippedReason}`);
    return;
  }
  const mayPublish = await mayPublishRuntimeEvidence(signal, config.leaseValid, () =>
    isPrStillOpen(octokit, ref),
  );
  if (!mayPublish) {
    console.log(
      '[worker] tier-2 runtime verify evidence discarded: review no longer owns an open PR',
    );
    return;
  }
  await publisher.publishArtifact(scope, `runtime-evidence:${effectiveSha}`, async () => {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: evidence,
    });
  });
  console.log(
    `[worker] tier-2 runtime verify posted: ran=${result.ran} steps=${result.steps.length}`,
  );
}
