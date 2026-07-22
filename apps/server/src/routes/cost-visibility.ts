import type { ReviewRun, WorkspaceStats } from '@orvex-review/store';

/** Internal model spend is opt-in per workspace; an unset allowlist fails closed. */
export function llmCostVisibleForTenant(
  tenantSlug: string,
  configuredTenants = process.env.ORVEX_LLM_COST_VISIBLE_TENANTS,
): boolean {
  const normalizedSlug = tenantSlug.trim().toLowerCase();
  return (configuredTenants ?? '')
    .split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalizedSlug);
}

export function workspaceStatsForTenant(
  stats: WorkspaceStats,
  canViewLlmCost: boolean,
): WorkspaceStats | Omit<WorkspaceStats, 'costUsd'> {
  if (canViewLlmCost) return stats;
  const { costUsd: _costUsd, ...withoutCost } = stats;
  return withoutCost;
}

export function reviewRunsForTenant(
  runs: ReviewRun[],
  canViewLlmCost: boolean,
): ReviewRun[] | Array<Omit<ReviewRun, 'costUsd'>> {
  if (canViewLlmCost) return runs;
  return runs.map(({ costUsd: _costUsd, ...withoutCost }) => withoutCost);
}
