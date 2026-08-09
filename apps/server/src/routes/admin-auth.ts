import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { IdentityRepository } from '@orvex-review/store';
import { sessionUser } from './session.js';
import { sameOriginRequest } from './request-security.js';
import type { ServerConfig } from '../bootstrap/config.js';

export type AdminAuthStore = Pick<IdentityRepository, 'getSessionUser' | 'upsertUserFromGitHub'>;
export type AdminAuthConfig = Pick<
  ServerConfig,
  'adminSecret' | 'appUrl' | 'authDisabled' | 'platformSecret'
>;

export function authorizedAdmin(c: Context, db: AdminAuthStore, config: AdminAuthConfig): boolean {
  if (sessionUser(c, db, config)?.isSuperAdmin) return true;

  // Keep the privileged tenant-plan and profitability routes on a credential
  // that cannot also invoke arbitrary reviews through POST /review.
  return validAdminSecret(c, config);
}

/** Browser-session mutations require a same-origin signal; bearer automation
 * remains valid without Origin/Referer headers. */
export function authorizedAdminMutation(
  c: Context,
  db: AdminAuthStore,
  config: AdminAuthConfig,
): boolean {
  if (validAdminSecret(c, config)) return true;
  if (!sessionUser(c, db, config)?.isSuperAdmin) return false;
  return sameOriginRequest(c, config);
}

function validAdminSecret(c: Context, config: Pick<ServerConfig, 'adminSecret'>): boolean {
  // Fail closed without a dedicated admin secret. Never fall back to
  // PLATFORM_SECRET — that value also signs sessions/OAuth/CSRF/TOTP, so a leak
  // there must not become full plan-mutation / superadmin automation.
  const configured = config.adminSecret;
  if (!configured) return false;
  const auth = c.req.header('authorization');
  const supplied = auth?.startsWith('Bearer ') ? auth.slice(7) : c.req.header('x-admin-secret');
  return Boolean(supplied && safeEqual(supplied, configured));
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
