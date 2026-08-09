import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../connection.js';
import type { GitHubInstallation, Tenant, WorkspaceMember, WorkspaceRole } from '../types.js';

export interface TenancyRepository {
  createTenant(slug: string, name?: string): Tenant;
  getTenantBySlug(slug: string): Tenant | null;
  getOrCreateTenant(slug: string, name?: string): Tenant;
  firstTenantSlug(): string | null;
  getTenantById(id: string): Tenant | null;
  getTenantByStripeCustomerId(customerId: string): Tenant | null;
  listStripeCustomers(): Array<{ tenantId: string; customerId: string }>;
  upsertInstallation(input: InstallationInput): GitHubInstallation;
  getInstallation(installationId: number): GitHubInstallation | null;
  getInstallationsForTenant(tenantId: string): GitHubInstallation[];
  findInstallationForRepo(owner: string, repo: string): GitHubInstallation | null;
  addWorkspaceMember(tenantId: string, userId: string, role: WorkspaceRole): WorkspaceMember;
  getMembership(tenantId: string, userId: string): WorkspaceMember | null;
  getWorkspacesForUser(userId: string): Array<{ tenant: Tenant; role: WorkspaceRole }>;
  tenantIsClaimable(tenantId: string): boolean;
  tenantHasMembers(tenantId: string): boolean;
}

export interface InstallationInput {
  installationId: number;
  tenantId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection?: string;
  suspendedAt?: string | null;
}

export class SqliteTenancyRepository implements TenancyRepository {
  constructor(
    private readonly db: SqliteConnection,
    private readonly defaultPlan: string,
  ) {}

  createTenant(slug: string, name?: string): Tenant {
    const id = randomUUID();
    const now = new Date().toISOString();
    const normalized = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const plan = this.defaultPlan;
    this.db
      .prepare(`INSERT INTO tenants (id, slug, name, created_at, plan) VALUES (?, ?, ?, ?, ?)`)
      .run(id, normalized, name ?? normalized, now, plan);
    return { id, slug: normalized, name: name ?? normalized, createdAt: now };
  }

  getTenantBySlug(slug: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, slug, name, created_at FROM tenants WHERE slug = ?`)
      .get(slug.toLowerCase()) as TenantRow | undefined;
    return row ? mapTenant(row) : null;
  }

  getOrCreateTenant(slug: string, name?: string): Tenant {
    return this.getTenantBySlug(slug) ?? this.createTenant(slug, name);
  }

  firstTenantSlug(): string | null {
    const row = this.db
      .prepare(
        `SELECT t.slug, (SELECT COUNT(*) FROM repos r WHERE r.tenant_id = t.id) AS repo_count,
              (SELECT COUNT(*) FROM github_installations gi WHERE gi.tenant_id = t.id AND gi.suspended_at IS NULL) AS inst_count
       FROM tenants t ORDER BY inst_count DESC, repo_count DESC, t.created_at ASC LIMIT 1`,
      )
      .get() as { slug: string } | undefined;
    return row?.slug ?? null;
  }

  getTenantById(id: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, slug, name, created_at FROM tenants WHERE id = ?`)
      .get(id) as TenantRow | undefined;
    return row ? mapTenant(row) : null;
  }

  getTenantByStripeCustomerId(customerId: string): Tenant | null {
    const row = this.db
      .prepare(`SELECT id, slug, name, created_at FROM tenants WHERE stripe_customer_id = ?`)
      .get(customerId) as TenantRow | undefined;
    return row ? mapTenant(row) : null;
  }

  listStripeCustomers(): Array<{ tenantId: string; customerId: string }> {
    return this.db
      .prepare(
        `SELECT id AS tenantId, stripe_customer_id AS customerId FROM tenants WHERE stripe_customer_id IS NOT NULL`,
      )
      .all() as Array<{ tenantId: string; customerId: string }>;
  }

  upsertInstallation(input: InstallationInput): GitHubInstallation {
    const now = new Date().toISOString();
    const existing = this.getInstallation(input.installationId);
    this.db
      .prepare(
        `INSERT INTO github_installations
       (installation_id, tenant_id, account_login, account_type, repository_selection, suspended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         tenant_id = github_installations.tenant_id, account_login = excluded.account_login,
         account_type = excluded.account_type, repository_selection = excluded.repository_selection,
         suspended_at = excluded.suspended_at, updated_at = excluded.updated_at`,
      )
      .run(
        input.installationId,
        input.tenantId,
        input.accountLogin,
        input.accountType,
        input.repositorySelection ?? 'selected',
        input.suspendedAt ?? null,
        existing?.createdAt ?? now,
        now,
      );
    return this.getInstallation(input.installationId)!;
  }

  getInstallation(installationId: number): GitHubInstallation | null {
    const row = this.db
      .prepare(
        `SELECT installation_id, tenant_id, account_login, account_type, repository_selection, suspended_at, created_at, updated_at
       FROM github_installations WHERE installation_id = ?`,
      )
      .get(installationId) as InstallationRow | undefined;
    return row ? mapInstallation(row) : null;
  }

  getInstallationsForTenant(tenantId: string): GitHubInstallation[] {
    return (
      this.db
        .prepare(
          `SELECT installation_id, tenant_id, account_login, account_type, repository_selection, suspended_at, created_at, updated_at
       FROM github_installations WHERE tenant_id = ? ORDER BY updated_at DESC`,
        )
        .all(tenantId) as InstallationRow[]
    ).map(mapInstallation);
  }

  findInstallationForRepo(owner: string, repo: string): GitHubInstallation | null {
    void repo;
    const row = this.db
      .prepare(
        `SELECT gi.installation_id FROM github_installations gi JOIN tenants t ON t.id = gi.tenant_id
       WHERE lower(gi.account_login) = lower(?) AND gi.suspended_at IS NULL LIMIT 1`,
      )
      .get(owner) as { installation_id: number } | undefined;
    return row ? this.getInstallation(row.installation_id) : null;
  }

  addWorkspaceMember(tenantId: string, userId: string, role: WorkspaceRole): WorkspaceMember {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspace_members (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(tenantId, userId, role, now);
    return { tenantId, userId, role, createdAt: now };
  }

  getMembership(tenantId: string, userId: string): WorkspaceMember | null {
    const row = this.db
      .prepare(`SELECT * FROM workspace_members WHERE tenant_id = ? AND user_id = ?`)
      .get(tenantId, userId) as MembershipRow | undefined;
    return row
      ? {
          tenantId: row.tenant_id,
          userId: row.user_id,
          role: row.role as WorkspaceRole,
          createdAt: row.created_at,
        }
      : null;
  }

  getWorkspacesForUser(userId: string): Array<{ tenant: Tenant; role: WorkspaceRole }> {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.slug, t.name, t.created_at, m.role FROM workspace_members m
       JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? ORDER BY t.created_at`,
      )
      .all(userId) as Array<TenantRow & { role: string }>;
    return rows.map((row) => ({ tenant: mapTenant(row), role: row.role as WorkspaceRole }));
  }

  tenantIsClaimable(tenantId: string): boolean {
    if (this.tenantHasMembers(tenantId)) return false;
    return (
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM github_installations WHERE tenant_id = ?`)
          .get(tenantId) as { n: number }
      ).n === 0
    );
  }

  tenantHasMembers(tenantId: string): boolean {
    return (
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE tenant_id = ?`)
          .get(tenantId) as { n: number }
      ).n > 0
    );
  }
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}
interface InstallationRow {
  installation_id: number;
  tenant_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
}
interface MembershipRow {
  tenant_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

function mapTenant(row: TenantRow): Tenant {
  return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at };
}
function mapInstallation(row: InstallationRow): GitHubInstallation {
  return {
    installationId: row.installation_id,
    tenantId: row.tenant_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection,
    suspendedAt: row.suspended_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
