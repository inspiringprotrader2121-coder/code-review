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

// Leading whitespace tolerated: GFM allows up to 3 spaces before a table, and
// the strict `^\|` form silently returned ZERO findings for an indented table.
const FINDING_HEADER = /^ {0,3}\|\s*Severity\s*\|\s*File\s*\|\s*Message\s*\|\s*$/i;
// GFM needs only ONE dash per cell; demanding {3,} made a `| -- | -- | -- |`
// divider parse as "not a table" and drop the whole section without a word.
const DIVIDER = /^ {0,3}\|\s*:?-+:?\s*\|\s*:?-+:?\s*\|\s*:?-+:?\s*\|\s*$/;
/**
 * Rows are parsed by LINEAR SCAN, not by regex.
 *
 * The regex form `\s*((?:\\\||[^|])*)\s*` is cubically ambiguous: `[^|]` also
 * matches whitespace, so a whitespace run can be split three ways between the
 * two `\s*` and the message group, and a non-matching row backtracks
 * catastrophically. Measured on a row ending in a long whitespace run with no
 * closing pipe: 418 B → 89 ms, 818 B → 582 ms, 1.6 kB → 2 990 ms, 2.4 kB →
 * did not finish in 5 s. The input is model-authored text rendered from an
 * attacker-controlled PR, so this is reachable, and adding `^ {0,3}` or
 * loosening the file cell does NOT remove the ambiguity — only dropping the
 * regex does.
 *
 * Returns the row's cells with `\|` unescaped, or null if the line is not a
 * table row at all.
 */
function splitTableRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  const inner = t.slice(1, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Anchored, unambiguous single-token checks applied to individual cells. */
const SEV_CELL = /^(P[0-3]|info)$/i;
const FILE_CELL = /^`(.*)`$/;

export function parseOrvexFileRef(ref: string): { path: string | null; line: number | null } {
  const match = /^(.+?):(\d+)$/.exec(ref.trim());
  if (match) return { path: match[1], line: Number(match[2]) };
  return { path: ref.trim() || null, line: null };
}

export function parseOrvexFindingTables(body: string): OrvexTableFinding[] {
  const findings: OrvexTableFinding[] = [];
  const skipped: string[] = [];
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
    if (!line.trimStart().startsWith('|')) {
      inFindingTable = false;
      continue;
    }
    const cells = splitTableRow(line);
    const sevCell = cells?.[0]?.trim() ?? '';
    const fileCell = cells?.[1]?.trim() ?? '';
    const fileMatch = FILE_CELL.exec(fileCell);
    const row =
      cells && cells.length >= 3 && SEV_CELL.test(sevCell) && fileMatch
        ? ([line, sevCell, fileMatch[1], cells.slice(2).join('|')] as const)
        : null;
    if (!row) {
      // Skip the unparseable row but KEEP SCANNING. Treating it as end-of-table
      // meant one odd row (a raw `|` in a message, an empty file cell, a legacy
      // severity token) silently discarded every finding below it — so a real
      // P1 on row 3 vanished because row 2 had a pipe in it, with no warning
      // and no counter. The pre-dccc51b parser was stateless and kept going.
      // Fail loudly instead: this harness decides whether we ship, and a parser
      // that quietly returns fewer findings reads as "Orvex found less".
      skipped.push(line.trim().slice(0, 120));
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

  if (skipped.length > 0) {
    console.warn(
      `[orvex-table] ${skipped.length} table row(s) did not parse and were skipped — ` +
        `finding counts are UNDERSTATED: ${skipped.join(' ⏎ ')}`,
    );
  }
  return findings;
}
