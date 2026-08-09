import type { InlineFindingRender } from './contracts.js';
import { applyCheckboxLine } from './apply-markers.js';
import { closeOpenFences, sanitizeFileCell, sanitizeFindingText } from './sanitize.js';

export function formatInlineFinding(render: InlineFindingRender): string {
  const finding = {
    ...render.finding,
    message: sanitizeFindingText(render.finding.message),
    suggestion: sanitizeFindingText(render.finding.suggestion),
  };
  const parts = [`**${finding.severity}** · \`${finding.ruleId}\``, '', finding.message];
  const suggestedLine = nativeSuggestionLine(render, finding.originalCode, finding.fixedCode);

  if (suggestedLine !== undefined) {
    closeOpenFences(parts);
    parts.push('', '```suggestion', suggestedLine, '```');
    parts.push(
      '',
      render.canAutofix !== false
        ? `⚡ **Apply instantly** with GitHub's **Commit suggestion** button above · <sub>or \`${render.trigger} fix this\` for an Orvex-verified commit · \`${render.trigger} explain\` · \`${render.trigger} ignore\`</sub>`
        : `⚡ **Apply instantly** with GitHub's **Commit suggestion** button above · <sub>\`${render.trigger} ignore\` to dismiss</sub>`,
    );
  } else if (render.canAutofix !== false) {
    if (finding.suggestion) parts.push('', finding.suggestion);
    closeOpenFences(parts);
    parts.push('', applyCheckboxLine(finding.fingerprint, finding.fixedCode !== undefined));
    parts.push(
      '',
      `<sub>Tick the box to let Orvex commit this fix — the ⏳ status updates in a moment (GitHub doesn't live-refresh bot edits, so give it a few seconds). Or \`${render.trigger} fix this\` · \`${render.trigger} <instructions>\` · \`${render.trigger} explain\` · \`${render.trigger} ignore\`</sub>`,
    );
  } else {
    if (finding.suggestion) parts.push('', finding.suggestion);
    parts.push(
      '',
      `<sub>Apply the suggested change above by hand, or [upgrade](https://useorvex.com/#pricing) to let Orvex commit fixes · \`${render.trigger} ignore\` to dismiss.</sub>`,
    );
  }

  parts.push(
    '',
    '<details><summary>🤖 Prompt for AI agents</summary>',
    '',
    '````',
    buildAgentPrompt(finding),
    '````',
    '</details>',
  );
  return parts.join('\n');
}

function nativeSuggestionLine(
  render: InlineFindingRender,
  originalCode: string | undefined,
  fixedCode: string | undefined,
): string | undefined {
  if (
    fixedCode === undefined ||
    originalCode === undefined ||
    originalCode.includes('\n') ||
    fixedCode.includes('\n') ||
    fixedCode.includes('```') ||
    render.lineRelocated ||
    render.anchorContext ||
    render.anchoredLine === undefined ||
    !render.anchoredLine.includes(originalCode)
  )
    return undefined;
  const line = render.anchoredLine.replace(originalCode, fixedCode);
  return line.includes('\n') ? undefined : line;
}

function buildAgentPrompt(finding: InlineFindingRender['finding']): string {
  const safeText = (value: string | undefined): string =>
    sanitizeFindingText(value).replace(/`{4,}/g, '```');
  const safeFile = (value: string | undefined): string =>
    sanitizeFileCell(value ?? '').replace(/`{4,}/g, '```');
  const location = finding.file
    ? finding.line
      ? `\`${safeFile(finding.file)}\` around line ${finding.line}`
      : `\`${safeFile(finding.file)}\``
    : 'the code at the line this comment is on';
  const output: string[] = [`Fix this issue in ${location}:`, '', safeText(finding.message).trim()];
  if (finding.originalCode && finding.fixedCode) {
    output.push(
      '',
      'Suggested change:',
      '```',
      `- ${safeText(finding.originalCode)}`,
      `+ ${safeText(finding.fixedCode)}`,
      '```',
    );
  } else if (finding.suggestion) {
    output.push('', `Suggested approach: ${safeText(finding.suggestion).trim()}`);
  }
  output.push(
    '',
    'Make only this change and keep the surrounding code, style, and behaviour intact. Do not touch unrelated code. If a test covers this path, update or add one.',
  );
  return output.join('\n');
}
