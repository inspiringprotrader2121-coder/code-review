import {
  commandTrigger,
  fingerprintFinding,
  formatInlineFinding,
  type ReviewFinding,
} from '@orvex-review/review';
import type { InlineReviewComment } from '@orvex-review/github';
import type { PlanFeatures } from '@orvex-review/tenants';

export function formatInlineBody(
  finding: ReviewFinding,
  canAutofix: boolean,
  contextFiles: Array<{ path: string; content: string }>,
): string {
  const content = contextFiles.find((file) => file.path === finding.file)?.content;
  const anchoredLine = finding.line && content ? content.split('\n')[finding.line - 1] : undefined;
  return formatInlineFinding({
    finding: {
      severity: finding.severity,
      ruleId: finding.ruleId,
      message: finding.message,
      suggestion: finding.suggestion,
      originalCode: finding.originalCode,
      fixedCode: finding.fixedCode,
      fingerprint: fingerprintFinding(finding),
      file: finding.file,
      line: finding.line,
    },
    trigger: commandTrigger(),
    canAutofix,
    anchoredLine,
    lineRelocated: finding.lineRelocated,
    anchorContext: finding.anchorContext,
  });
}

export function buildInlineComments(
  findings: ReviewFinding[],
  plan: PlanFeatures,
  contextFiles: Array<{ path: string; content: string }>,
): InlineReviewComment[] {
  return findings
    .filter((finding) => finding.line)
    .map((finding) => ({
      path: finding.file,
      line: finding.line!,
      body: formatInlineBody(finding, plan.autofix, contextFiles),
    }));
}
