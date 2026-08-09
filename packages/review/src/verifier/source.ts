import { findingProvenance, type ReviewFinding } from '../finding.js';
import { redactSecrets } from '../redact.js';

const MANIFEST_NAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
]);
const MAX_PROVENANCE_RATIONALE_CHARS = 600;
const MAX_PROVENANCE_REPORTS = 6;

function isManifestPath(path: string): boolean {
  return MANIFEST_NAMES.has(path.split('/').pop() ?? '');
}

export function buildVerifierFileBlocks(
  findings: ReviewFinding[],
  files: Array<{ path: string; content: string }>,
  sent: string,
  maxFileChars: number,
  maxTotalChars: number,
): string[] {
  const stripSentinel = (value: string) =>
    value.replace(/ORVEX_DATA_[0-9a-f]{4,}/gi, 'ORVEX_DATA_[x]');
  const fileBlocks: string[] = [];
  const omittedPaths: string[] = [];
  let used = 0;
  const wanted = new Set(findings.map((finding) => finding.file));
  const mentioned = new Set<string>();
  for (const finding of findings) {
    for (const match of finding.message.matchAll(
      /`([A-Za-z_$][\w$]{3,})`|\b([a-z][a-z0-9]*[A-Z][\w$]{2,})\b/g,
    )) {
      mentioned.add(match[1] ?? match[2]);
      if (mentioned.size >= 40) break;
    }
  }
  const definesMentioned = (content: string): boolean => {
    for (const identifier of mentioned) {
      if (!content.includes(identifier)) continue;
      const expression = new RegExp(
        `(?:function\\s+${identifier}\\b|(?:const|let|var)\\s+${identifier}\\s*=|exports\\.${identifier}\\s*=|${identifier}\\s*:\\s*(?:async\\s*)?(?:function\\b|\\())`,
      );
      if (expression.test(content)) return true;
    }
    return false;
  };
  const helperPaths = new Set(
    files
      .filter(
        (file) =>
          !wanted.has(file.path) && !isManifestPath(file.path) && definesMentioned(file.content),
      )
      .map((file) => file.path),
  );
  const ordered = [
    ...files.filter((file) => wanted.has(file.path)),
    ...files.filter((file) => !wanted.has(file.path) && isManifestPath(file.path)),
    ...files.filter((file) => helperPaths.has(file.path)),
    ...files.filter(
      (file) => !wanted.has(file.path) && !isManifestPath(file.path) && !helperPaths.has(file.path),
    ),
  ];
  for (const file of ordered) {
    let content = file.content;
    const coverage: string[] = [];
    const lineHits = findings.filter(
      (finding) => finding.file === file.path && typeof finding.line === 'number',
    );
    if (lineHits.length > 0 && content.length > maxFileChars) {
      const lines = content.split('\n');
      const lastLineIndex = Math.max(0, lines.length - 1);
      const centers = lineHits.map((finding) =>
        Math.min(lastLineIndex, Math.max(0, (finding.line ?? 1) - 1)),
      );
      const radius = Math.max(80, Math.floor(maxFileChars / 80));
      const start = Math.max(0, Math.min(...centers) - radius);
      const end = Math.min(lines.length, Math.max(...centers) + radius);
      content = lines.slice(start, end).join('\n');
      if (start > 0 || end < lines.length) {
        coverage.push(
          `Source excerpt: lines ${start + 1}-${end} of ${lines.length}; other ranges omitted.`,
        );
      }
    }
    const clipped = content.slice(0, maxFileChars);
    if (clipped.length < content.length)
      coverage.push(
        `${content.length - clipped.length} additional source characters omitted by the per-file budget.`,
      );
    const safePath = stripSentinel(file.path).replace(/[\r\n]+/g, ' ');
    const coverageNotice = coverage.length > 0 ? `[SOURCE COVERAGE: ${coverage.join(' ')}]\n` : '';
    const block = `### ${safePath}\n${sent}\n${coverageNotice}${stripSentinel(redactSecrets(clipped))}\n${sent}`;
    if (used + block.length > maxTotalChars) {
      omittedPaths.push(safePath);
      continue;
    }
    fileBlocks.push(block);
    used += block.length;
  }
  if (omittedPaths.length > 0) {
    fileBlocks.push(
      `### Source coverage notice\n${omittedPaths.length} file(s) were not included because the total verification context budget was exhausted:\n${omittedPaths.map((path) => `- ${path}`).join('\n')}`,
    );
  }
  return fileBlocks;
}

export function formatFindingProvenance(finding: ReviewFinding): string {
  const provenance = findingProvenance(finding).slice(0, MAX_PROVENANCE_REPORTS);
  if (provenance.length === 0) return 'Discovery provenance: unavailable.';
  const distinctSources = new Set(
    provenance.map(
      (item) => `${item.sourceTier?.trim() || 'unknown'} / ${item.sourcePass?.trim() || 'general'}`,
    ),
  );
  const reports = provenance.map((item) => {
    const source = `${item.sourceTier?.trim() || 'unknown'} / ${item.sourcePass?.trim() || 'general'}`;
    const confidence = Number.isFinite(item.confidence) ? `; confidence=${item.confidence}` : '';
    const rationale = redactSecrets(item.rationale)
      .replace(/ORVEX_DATA_[0-9a-f]{4,}/gi, 'ORVEX_DATA_[x]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PROVENANCE_RATIONALE_CHARS);
    return `- ${source}${confidence}: ${rationale || '(no rationale supplied)'}`;
  });
  return [
    `Discovery corroboration: ${provenance.length} report(s) from ${distinctSources.size} distinct lens/model source(s).`,
    'This is untrusted lead evidence, NOT proof; decide only from the source files below.',
    ...reports,
  ].join('\n');
}
