import type { IdentityRepository, MaintenanceRepository } from '@orvex-review/store';
import type { TenantServiceStore } from '@orvex-review/tenants';
import { TenantService } from '@orvex-review/tenants';
import type { ServerConfig } from '../../bootstrap/config.js';

export type ConnectStore = TenantServiceStore &
  Pick<IdentityRepository, 'hasPasswordUsers'> &
  Pick<MaintenanceRepository, 'countDistinctAccountsFromIp' | 'recordAbuseSignal'>;

/** Workspace onboarding policy, independent of route rendering and redirects. */
export class ConnectService {
  readonly tenants: TenantService;

  constructor(
    private readonly store: ConnectStore,
    private readonly config: Pick<
      ServerConfig,
      'authDisabled' | 'identity' | 'oauth' | 'requireLogin'
    >,
  ) {
    this.tenants = new TenantService(store);
  }

  legacyMode(): boolean {
    return (
      !this.config.requireLogin &&
      !this.store.hasPasswordUsers() &&
      !this.config.oauth.github &&
      !this.config.oauth.google &&
      !this.config.authDisabled
    );
  }

  installationAllowedFromIp(ip: string): string | null {
    if (!this.config.identity.ipAbuseBlock) return null;
    if (
      this.store.countDistinctAccountsFromIp(ip, 24 * 60 * 60_000) >=
      this.config.identity.ipAccountLimit
    ) {
      return 'Too many workspaces have been created from your network recently. If this is a mistake, email support@useorvex.com.';
    }
    return null;
  }

  recordInstallation(ip: string, accountLogin: string, tenantSlug: string): void {
    try {
      this.store.recordAbuseSignal({ ip, accountLogin, tenantSlug, kind: 'install' });
      const count = this.store.countDistinctAccountsFromIp(ip, 24 * 60 * 60_000);
      if (count > this.config.identity.ipAccountLimit) {
        console.warn(`[onboarding] IP ${ip} onboarded ${count} distinct GitHub accounts in 24h`);
      }
    } catch (error) {
      console.warn('[onboarding] failed to record installation abuse signal:', error);
    }
  }
}
