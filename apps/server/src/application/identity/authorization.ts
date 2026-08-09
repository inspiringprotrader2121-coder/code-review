import type { Context } from 'hono';
import type {
  IdentityRepository,
  Tenant,
  TenancyRepository,
  User,
  WorkspaceRole,
} from '@orvex-review/store';
import { sessionUser } from '../../routes/session.js';
import type { ServerConfig } from '../../bootstrap/config.js';

export type Capability =
  | 'workspace:read'
  | 'workspace:manage'
  | 'identity:manage'
  | 'superadmin:read'
  | 'superadmin:manage';
export type WorkspaceAuthorization = { tenant: Tenant; role: WorkspaceRole; user: User | null };
export type AuthorizationFailure = {
  status: 401 | 403 | 404;
  code: 'not_signed_in' | 'not_a_member' | 'workspace_not_found';
};
export type AuthorizationStore = Pick<
  IdentityRepository,
  'getSessionUser' | 'hasPasswordUsers' | 'upsertUserFromGitHub'
> &
  Pick<TenancyRepository, 'getMembership' | 'getTenantBySlug'>;

/** Central tenant and role decisions. Routes translate these decisions to HTTP. */
export class AuthorizationService {
  constructor(
    private readonly db: AuthorizationStore,
    private readonly config: Pick<ServerConfig, 'authDisabled' | 'oauth' | 'requireLogin'>,
  ) {}

  authenticatedUser(c: Context): User | null {
    return sessionUser(c, this.db, this.config);
  }

  workspace(c: Context, slug: string): WorkspaceAuthorization | AuthorizationFailure {
    if (this.legacyAuthMode()) {
      const tenant = this.db.getTenantBySlug(slug);
      return tenant
        ? { tenant, role: 'owner', user: null }
        : { status: 404, code: 'workspace_not_found' };
    }
    const user = this.authenticatedUser(c);
    if (!user) return { status: 401, code: 'not_signed_in' };
    const tenant = this.db.getTenantBySlug(slug);
    if (!tenant) return { status: 404, code: 'workspace_not_found' };
    const membership = this.db.getMembership(tenant.id, user.id);
    return membership
      ? { tenant, role: membership.role, user }
      : { status: 403, code: 'not_a_member' };
  }

  allows(subject: WorkspaceAuthorization, capability: Capability): boolean {
    switch (capability) {
      case 'workspace:read':
        return true;
      case 'workspace:manage':
        return subject.role === 'owner';
      case 'identity:manage':
        return subject.user !== null;
      case 'superadmin:read':
        return Boolean(subject.user?.isSuperAdmin);
      case 'superadmin:manage':
        return Boolean(subject.user?.isSuperAdmin && !this.config.authDisabled);
    }
  }

  private legacyAuthMode(): boolean {
    return (
      !this.config.requireLogin &&
      !this.db.hasPasswordUsers() &&
      !this.config.oauth.github &&
      !this.config.oauth.google &&
      !this.config.authDisabled
    );
  }
}
