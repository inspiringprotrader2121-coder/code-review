import type { BillingRepository, IdentityRepository, TenancyRepository } from '@orvex-review/store';
import { planFeatures, type PlanFeatures } from '@orvex-review/tenants';
import { llmCostVisibleForTenant } from '../../routes/cost-visibility.js';
import type { ServerConfig } from '../../bootstrap/config.js';

/** Data required to render a dashboard. The route owns redirects and HTML only. */
export type DashboardStore = Pick<
  TenancyRepository,
  'firstTenantSlug' | 'getMembership' | 'getTenantBySlug' | 'getWorkspacesForUser'
> &
  Pick<BillingRepository, 'getCreditBalanceCents' | 'getTenantPlan'> &
  Pick<IdentityRepository, 'hasPasswordUsers'>;

export type DashboardAccess =
  | { kind: 'legacy'; slug: string }
  | { kind: 'login' }
  | { kind: 'connect' }
  | { kind: 'workspace'; slug: string };

export type DashboardViewState = {
  isSuperAdmin: boolean;
  canManageBilling: boolean;
  showLlmCost: boolean;
  plan: PlanFeatures;
  creditBalanceCents: number;
};

export class DashboardService {
  constructor(
    private readonly store: DashboardStore,
    private readonly config: Pick<
      ServerConfig,
      'authDisabled' | 'costVisibilityTenants' | 'oauth' | 'requireLogin'
    >,
  ) {}

  landing(userId: string | null): DashboardAccess {
    if (this.legacyAuthMode())
      return { kind: 'legacy', slug: this.store.firstTenantSlug() ?? 'default' };
    if (!userId) return { kind: 'login' };
    const workspace = this.store.getWorkspacesForUser(userId)[0];
    return workspace ? { kind: 'workspace', slug: workspace.tenant.slug } : { kind: 'connect' };
  }

  view(
    slug: string,
    user: { id: string; isSuperAdmin: boolean } | null,
  ): DashboardViewState | null {
    const tenant = this.store.getTenantBySlug(slug);
    if (!tenant) return null;
    let isSuperAdmin = false;
    let canManageBilling = true;
    if (!this.legacyAuthMode()) {
      if (!user) return null;
      const membership = this.store.getMembership(tenant.id, user.id);
      if (!membership) return null;
      isSuperAdmin = user.isSuperAdmin;
      canManageBilling = membership.role === 'owner';
    }
    return {
      isSuperAdmin,
      canManageBilling,
      showLlmCost: llmCostVisibleForTenant(tenant.slug, this.config.costVisibilityTenants),
      plan: planFeatures(this.store.getTenantPlan(tenant.id)),
      creditBalanceCents: this.store.getCreditBalanceCents(tenant.id),
    };
  }

  private legacyAuthMode(): boolean {
    return (
      !this.config.requireLogin &&
      !this.store.hasPasswordUsers() &&
      !this.config.oauth.github &&
      !this.config.oauth.google &&
      !this.config.authDisabled
    );
  }
}
