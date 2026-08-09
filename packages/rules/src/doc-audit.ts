/** Ported from pr-review-bot-loop/doc-audit-verify.mjs */

export function hasEscapedPipeInTestPatterns(text: string): boolean {
  return /testPathPatterns='[^'\n]*\\\|/.test(text || '');
}

export function hasTestPathPatternsInTableRow(text: string): boolean {
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/testPathPatterns=/.test(trimmed)) return true;
  }
  return false;
}

export function hasUnsafePipeInTableCells(text: string): boolean {
  for (const line of (text || '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const parts = line.split('`');
    for (let i = 1; i < parts.length; i += 2) {
      const cell = parts[i];
      if (!cell) continue;
      if (/testPathPatterns='[^']*\|/.test(cell) && !cell.includes('&#124;')) return true;
      if (cell.includes('&#124;') && cell.includes('testPathPatterns')) return true;
    }
  }
  return false;
}

export function hasWrongValidateDeployScript(text: string): boolean {
  return /validate-deploy-config/.test(text || '');
}

export function hasSliceIndexPlaceholder(text: string): boolean {
  return /\|\s*06–17\s*\|.*slice-06-\*/.test(text || '');
}

export function hasMixedBackendSrcPaths(text: string): boolean {
  const scope = (text || '').match(/## Scope map[\s\S]*?(?=\n## )/)?.[0] || '';
  if (!scope) return false;
  const hasSrcPrefix = /`src\//.test(scope);
  const hasRelativeWithoutSrc = /`(?:index|lib|routes)\//.test(scope);
  return hasSrcPrefix && hasRelativeWithoutSrc;
}

export function getAuditDocIssues(content: string, filePath = ''): string[] {
  if (!content || !String(filePath).endsWith('.md')) return [];
  const issues: string[] = [];
  if (hasEscapedPipeInTestPatterns(content)) issues.push('escaped_pipe_in_test_patterns');
  if (hasTestPathPatternsInTableRow(content)) issues.push('test_path_patterns_in_table');
  if (hasUnsafePipeInTableCells(content)) issues.push('unsafe_pipe_in_table_cell');
  if (hasWrongValidateDeployScript(content)) issues.push('wrong_validate_deploy_script');
  if (hasSliceIndexPlaceholder(content)) issues.push('slice_index_placeholder');
  if (filePath.includes('slice-05') && hasMixedBackendSrcPaths(content)) {
    issues.push('mixed_backend_src_paths');
  }
  return issues;
}

export function auditDocIssuesOpenOnHead(content: string, filePath: string): boolean {
  return getAuditDocIssues(content, filePath).length > 0;
}

const ISSUE_MESSAGES: Record<string, { message: string; suggestion: string }> = {
  escaped_pipe_in_test_patterns: {
    message: 'Escaped pipe in testPathPatterns — use a fenced bash block instead of a table cell',
    suggestion:
      'Move the testPathPatterns command out of the markdown table into a ```bash fenced block.',
  },
  test_path_patterns_in_table: {
    message: 'testPathPatterns must not appear inside a markdown table row',
    suggestion:
      'Use a short label in the table and put the full command in a fenced code block below.',
  },
  unsafe_pipe_in_table_cell: {
    message: 'Unsafe pipe character in markdown table cell with testPathPatterns',
    suggestion:
      'Avoid raw `|` in table cells; use fenced blocks or HTML entity &#124; only when appropriate.',
  },
  wrong_validate_deploy_script: {
    message: 'References validate-deploy-config script which does not exist',
    suggestion: 'Use the correct deploy validation script name for this repo.',
  },
  slice_index_placeholder: {
    message: 'Slice index table still contains placeholder slice-06-* range',
    suggestion: 'Replace placeholder slice references with actual slice paths.',
  },
  mixed_backend_src_paths: {
    message: 'Scope map mixes `src/` prefixed and relative backend paths',
    suggestion: 'Use consistent `src/` prefixes for all backend paths in the scope map.',
  },
};

export interface AuditRuleFinding {
  file: string;
  line?: number;
  severity: 'P2' | 'P3';
  category: 'audit-doc';
  message: string;
  suggestion?: string;
  confidence: number;
  ruleId: string;
}

export function auditFindingsFromContent(content: string, filePath: string): AuditRuleFinding[] {
  const issues = getAuditDocIssues(content, filePath);
  return issues.map((issue) => {
    const meta = ISSUE_MESSAGES[issue] ?? {
      message: `Audit doc issue: ${issue}`,
      suggestion: 'Fix the markdown audit document formatting.',
    };
    return {
      file: filePath,
      severity: 'P2' as const,
      category: 'audit-doc' as const,
      message: meta.message,
      suggestion: meta.suggestion,
      confidence: 1,
      ruleId: `audit.${issue}`,
    };
  });
}
