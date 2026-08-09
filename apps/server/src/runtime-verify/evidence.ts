import { redactSecrets, sanitizeFindingText } from '@orvex-review/review';
import type { RuntimeVerifyResult } from './contracts.js';

/** Last ~2k chars of output, redacted before it can reach a PR comment. */
export function tailRuntimeOutput(output: string, limit = 2_000): string {
  const redacted = redactSecrets(output.trimEnd());
  return redacted.length > limit ? `…\n${redacted.slice(-limit)}` : redacted;
}

function fenceSafeOutput(output: string): string {
  return sanitizeFindingText(redactSecrets(output))
    .replace(/`/g, "'")
    .replace(/\u0000/g, '');
}

/** Render a runtime-verification result as a PR comment body. */
export function formatRuntimeEvidence(result: RuntimeVerifyResult): string | null {
  if (!result.ran) return null;
  const lines: string[] = ['### 🧪 Orvex runtime verification'];
  const failed = result.steps.filter((step) => !step.ok);
  const newFailures = failed.filter((step) => !step.preExisting);
  if (failed.length === 0) {
    lines.push(
      `✅ Ran the change in an isolated sandbox — ${result.steps.map((step) => step.name).join(' + ')} passed.`,
    );
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
  for (const step of result.steps) {
    const status = step.timedOut ? '⏱️ timed out' : step.ok ? '✅ passed' : '❌ failed';
    const preExisting = step.preExisting ? ' — also fails at base (pre-existing)' : '';
    const safeCommand = fenceSafeOutput(step.command).replace(/\n/g, ' ');
    lines.push(
      `\n**${sanitizeFindingText(step.name)}** — \`${safeCommand}\` — ${status}${preExisting} (${Math.round(step.durationMs / 1000)}s)`,
    );
    if (!step.ok && step.output) lines.push('```\n' + fenceSafeOutput(step.output) + '\n```');
  }
  return lines.join('\n');
}
