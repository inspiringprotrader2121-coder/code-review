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

interface SemgrepJsonResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: {
    message?: string;
    severity?: string;
  };
}

export function semgrepScanArgs(paths: string[]): string[] {
  return ['scan', '--config', 'auto', '--json', '--quiet', '--', ...paths];
}

export function parseSemgrepOutput(stdout: string): SemgrepFinding[] {
  try {
    return parseSemgrepJson(stdout);
  } catch (error) {
    console.warn(
      '[semgrep] skipped malformed JSON:',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

export async function runSemgrepOnPaths(
  paths: string[],
  cwd?: string,
  runtimeConfig: RulesRuntimeConfig = loadRulesRuntimeConfig(),
): Promise<SemgrepFinding[]> {
  if (paths.length === 0) return [];
  if (runtimeConfig.semgrepDisabled) return [];

  try {
    const { stdout } = await execFileAsync('semgrep', semgrepScanArgs(paths), {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    return parseSemgrepOutput(stdout);
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; code?: number };
    if (execErr.stdout) return parseSemgrepOutput(execErr.stdout);
    console.warn('[semgrep] skipped:', execErr instanceof Error ? execErr.message : err);
    return [];
  }
}

export function parseSemgrepJson(stdout: string): SemgrepFinding[] {
  const data = JSON.parse(stdout) as { results?: SemgrepJsonResult[] };
  const findings: SemgrepFinding[] = [];

  for (const r of data.results ?? []) {
    const file = r.path;
    const line = r.start?.line;
    if (!file || !line) continue;

    const level = r.extra?.severity?.toUpperCase() ?? 'WARNING';
    const severity =
      level === 'CRITICAL' || level === 'ERROR'
        ? 'P1'
        : level === 'HIGH' || level === 'WARNING'
          ? 'P2'
          : 'P3';

    findings.push({
      file,
      line,
      severity,
      category: 'semgrep',
      message: r.extra?.message ?? r.check_id ?? 'Semgrep finding',
      confidence: 0.95,
      ruleId: `semgrep.${r.check_id ?? 'unknown'}`,
    });
  }

  return findings;
}
