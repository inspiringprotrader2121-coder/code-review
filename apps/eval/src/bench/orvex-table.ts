/**
 * Parse confirmed Orvex finding tables from a review body.
 *
 * A review contains several markdown tables. Only tables with the exact
 * `Severity | File | Message` schema represent confirmed findings; tables such
 * as manual-review candidates must never inflate benchmark coverage.
 */
export interface OrvexTableFinding {
  path: string | null;
  line: number | null;
  severity: 'P1' | 'P2' | 'P3' | 'info';
  message: string;
}

const FINDING_HEADER = /^\|\s*Severity\s*\|\s*File\s*\|\s*Message\s*\|\s*$/i;
const DIVIDER = /^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*$/;
const FINDING_ROW = /^\|\s*(P[0-3]|info)\s*\|\s*`([^`]+)`\s*\|\s*((?:\\\||[^|])*)\s*\|\s*$/i;

export function parseOrvexFileRef(ref: string): { path: string | null; line: number | null } {
  const match = /^(.+?):(\d+)$/.exec(ref.trim());
  if (match) return { path: match[1], line: Number(match[2]) };
  return { path: ref.trim() || null, line: null };
}

export function parseOrvexFindingTables(body: string): OrvexTableFinding[] {
  const findings: OrvexTableFinding[] = [];
  let inFindingTable = false;
  let sawDivider = false;

  for (const line of body.split('\n')) {
    if (FINDING_HEADER.test(line)) {
      inFindingTable = true;
      sawDivider = false;
      continue;
    }
    if (!inFindingTable) continue;
    if (!sawDivider) {
      if (DIVIDER.test(line)) sawDivider = true;
      else inFindingTable = false;
      continue;
    }
    if (!line.startsWith('|')) {
      inFindingTable = false;
      continue;
    }
    const row = FINDING_ROW.exec(line);
    if (!row) {
      inFindingTable = false;
      continue;
    }
    const { path, line: lineNumber } = parseOrvexFileRef(row[2]);
    const severity = row[1].toUpperCase() === 'P0'
      ? 'P1'
      : row[1].toLowerCase() === 'info'
        ? 'info'
        : row[1].toUpperCase() as 'P1' | 'P2' | 'P3';
    findings.push({
      path,
      line: lineNumber,
      severity,
      message: row[3].replace(/\\\|/g, '|').trim(),
    });
  }

  return findings;
}
