import { fingerprintFinding, type ReviewFinding } from './finding.js';

export interface ModelContributionRow {
  /** sourceTier or sourcePass label */
  key: string;
  /** Findings attributed to this key (after fingerprint dedupe within the set). */
  count: number;
  /** Findings only this key produced (no other key shared the fingerprint). */
  uniqueCount: number;
}

export interface ModelContributionReport {
  total: number;
  byTier: ModelContributionRow[];
  byPass: ModelContributionRow[];
}

function summarizeBy(
  findings: ReviewFinding[],
  keyOf: (f: ReviewFinding) => string,
): { total: number; rows: ModelContributionRow[] } {
  const byFp = new Map<string, Set<string>>();
  for (const f of findings) {
    const key = keyOf(f);
    const fp = fingerprintFinding(f);
    const keys = byFp.get(fp) ?? new Set<string>();
    keys.add(key);
    byFp.set(fp, keys);
  }

  const totals = new Map<string, { count: number; unique: number }>();
  for (const keys of byFp.values()) {
    for (const key of keys) {
      const row = totals.get(key) ?? { count: 0, unique: 0 };
      row.count += 1;
      if (keys.size === 1) row.unique += 1;
      totals.set(key, row);
    }
  }

  const rows = [...totals.entries()]
    .map(([key, v]) => ({ key, count: v.count, uniqueCount: v.unique }))
    .sort((a, b) => b.uniqueCount - a.uniqueCount || b.count - a.count || a.key.localeCompare(b.key));

  return { total: byFp.size, rows };
}

/**
 * Attribute a finding set to models via `sourceTier` and lenses via `sourcePass`.
 * Pass the pre-dedupe accumulation when measuring multi-model overlap — after
 * fingerprint union only one tier survives per bug.
 */
export function summarizeModelContribution(
  findings: ReviewFinding[],
): ModelContributionReport {
  const byTier = summarizeBy(findings, (f) => f.sourceTier?.trim() || 'unknown');
  const withPass = findings.filter((f) => f.sourcePass?.trim());
  const byPass = withPass.length
    ? summarizeBy(withPass, (f) => f.sourcePass!.trim())
    : { total: 0, rows: [] as ModelContributionRow[] };
  return {
    total: byTier.total,
    byTier: byTier.rows,
    byPass: byPass.rows,
  };
}

/** Compact one-line summary for worker logs. */
export function formatModelContribution(report: ModelContributionReport): string {
  if (report.byTier.length === 0) return 'none';
  const tiers = report.byTier
    .map((r) => `${r.key}:${r.count} (${r.uniqueCount} unique)`)
    .join(', ');
  if (report.byPass.length === 0) return tiers;
  const passes = report.byPass
    .map((r) => `${r.key}:${r.count} (${r.uniqueCount} unique)`)
    .join(', ');
  return `${tiers} | lenses: ${passes}`;
}
