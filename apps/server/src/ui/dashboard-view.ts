import type { PlanFeatures } from '@orvex-review/tenants';

export interface DashboardBootstrapView {
  workspaceSlug: string;
  showLlmCost: boolean;
}

export interface DashboardPageView extends DashboardBootstrapView {
  isSuperAdmin: boolean;
  logoutCsrf: string | null;
  plan: PlanFeatures;
  canManageBilling: boolean;
  creditBalanceCents: number;
  billingBannerHtml: string;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Serializable values consumed by the external dashboard module, never executable JS. */
export function dashboardBootstrapAttributes(view: DashboardBootstrapView): string {
  return `data-workspace-slug="${escapeAttribute(view.workspaceSlug)}" data-show-llm-cost="${view.showLlmCost ? 'true' : 'false'}"`;
}
