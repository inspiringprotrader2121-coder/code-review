import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRulesRuntimeConfig, type RulesRuntimeConfig } from '@orvex-review/config';

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

/** Native `semgrep --json` result shape (not SARIF). */
interface SemgrepJsonResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: {
    severity?: string;
    message?: string;
  };
}

export async function runSemgrepOnPaths(
  paths: string[],
  cwd?: string,
  runtimeConfig: RulesRuntimeConfig = loadRulesRuntimeConfig(),
): Promise<SemgrepFinding[]> {
  if (paths.length === 0) return [];
  if (runtimeConfig.semgrepDisabled) return [];

  try {
    const { stdout } = await execFileAsync(
      'semgrep',
      // `--config auto` is required when the repo has no semgrep.yaml; without it
      // recent semgrep builds exit with "No config given". `--json` emits the
      // native results schema (check_id/path/start), not SARIF.
      ['scan', '--config', 'auto', '--json', '--quiet', '--', ...paths],
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

/** Exported for unit tests. */
export function parseSemgrepJson(stdout: string): SemgrepFinding[] {
  const data = JSON.parse(stdout) as { results?: SemgrepJsonResult[] };
  const findings: SemgrepFinding[] = [];

  for (const r of data.results ?? []) {
    const file = r.path;
    const line = r.start?.line;
    if (!file || !line) continue;

    const level = (r.extra?.severity ?? 'WARNING').toUpperCase();
    const severity = level === 'ERROR' ? 'P1' : level === 'WARNING' ? 'P2' : 'P3';
    const ruleId = r.check_id ?? 'unknown';

    findings.push({
      file,
      line,
      severity,
      category: 'semgrep',
      message: r.extra?.message ?? ruleId,
      confidence: 0.95,
      ruleId: `semgrep.${ruleId}`,
    });
  }

  return findings;
}
