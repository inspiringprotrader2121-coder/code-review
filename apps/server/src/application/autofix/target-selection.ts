import { commandTrigger, generateFixWithLlm, type CodeFix } from '@orvex-review/review';
import type { FixRequest } from '@orvex-review/queue';
import type { StoredFinding } from '@orvex-review/store';
import type { CommandUsageRecorder, AutofixDependencies } from './contracts.js';

export const SKIP_REASONS: Record<string, string> = {
  not_found: `the code changed since the review — re-run \`${commandTrigger()} review\` first`,
  already_fixed: 'already fixed — the suggested change is already present in the file',
  ambiguous: 'the target code appears in several places and could not be located safely',
  noop: 'the fix is identical to the current code',
  no_fix: 'no safe fix could be generated',
  file_missing: 'the file no longer exists on the branch head',
};

export function selectTargets(open: StoredFinding[], fix: FixRequest): StoredFinding[] {
  if (fix.scope === 'one') {
    const byFingerprint = fix.fingerprint
      ? open.filter((finding) => finding.fingerprint === fix.fingerprint)
      : [];
    if (byFingerprint.length > 0) return byFingerprint;
    return fix.replyToCommentId
      ? open.filter((finding) => finding.githubCommentId === fix.replyToCommentId)
      : [];
  }
  return fix.scope === 'ready'
    ? open.filter((finding) => finding.originalCode && finding.fixedCode !== undefined)
    : [...open];
}

export async function resolveCodeFix(
  finding: StoredFinding,
  fileContent: string,
  fix: FixRequest,
  dependencies: AutofixDependencies,
  relatedFiles: Array<{ path: string; content: string }> | undefined,
  onUsage: CommandUsageRecorder | undefined,
): Promise<CodeFix | null> {
  if (!fix.instruction && finding.originalCode && finding.fixedCode !== undefined) {
    return { originalCode: finding.originalCode, fixedCode: finding.fixedCode, line: finding.line };
  }
  return generateFixWithLlm(
    {
      filePath: finding.file,
      fileContent,
      findingMessage: finding.message,
      findingLine: finding.line,
      suggestion: finding.suggestion,
      instruction: fix.instruction,
      relatedFiles,
    },
    {
      apiKey: dependencies.standardModel.apiKey,
      model: dependencies.standardModel.model,
      baseUrl: dependencies.standardModel.baseUrl,
      api: dependencies.standardModel.api,
      reasoningEffort: dependencies.standardModel.reasoningEffort,
      onUsage,
    },
  );
}

export function isTransientGitHubError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const status = (error as { status: unknown }).status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}
