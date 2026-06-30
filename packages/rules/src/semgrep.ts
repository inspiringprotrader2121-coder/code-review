import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SemgrepFinding {
  file: string;
  line: number;
  severity: 'P1' | 'P2' | 'P3';
  category: string;
  message: string;
  suggestion?: string;
  confidence: number;
  ruleId: string;
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }>;
}

export async function runSemgrepOnPaths(
  paths: string[],
  cwd?: string,
): Promise<SemgrepFinding[]> {
  if (paths.length === 0) return [];
  if (process.env.SEMGREP_DISABLED === '1') return [];

  try {
    const { stdout } = await execFileAsync(
      'semgrep',
      ['scan', '--json', '--quiet', '--', ...paths],
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
    );
    return parseSemgrepJson(stdout);
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; code?: number };
    if (execErr.stdout) return parseSemgrepJson(execErr.stdout);
    console.warn('[semgrep] skipped:', execErr instanceof Error ? execErr.message : err);
    return [];
  }
}

function parseSemgrepJson(stdout: string): SemgrepFinding[] {
  const data = JSON.parse(stdout) as { results?: SarifResult[] };
  const findings: SemgrepFinding[] = [];

  for (const r of data.results ?? []) {
    const file = r.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
    const line = r.locations?.[0]?.physicalLocation?.region?.startLine;
    if (!file || !line) continue;

    const level = r.level ?? 'warning';
    const severity = level === 'error' ? 'P1' : level === 'warning' ? 'P2' : 'P3';

    findings.push({
      file,
      line,
      severity,
      category: 'semgrep',
      message: r.message?.text ?? r.ruleId ?? 'Semgrep finding',
      confidence: 0.95,
      ruleId: `semgrep.${r.ruleId ?? 'unknown'}`,
    });
  }

  return findings;
}
