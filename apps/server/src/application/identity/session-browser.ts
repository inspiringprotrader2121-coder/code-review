import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { IdentityRepository, User } from '@orvex-review/store';
import { RequestSecurity } from './request-security.js';

export const SESSION_COOKIE = 'orvex_session';

export type SessionBrowserConfig = Readonly<{
  appUrl: string;
  authDisabled?: boolean;
  platformSecret: string;
}>;

export function developmentUser(db: Pick<IdentityRepository, 'upsertUserFromGitHub'>): User {
  return db.upsertUserFromGitHub({ githubId: 0, login: 'dev', name: 'Dev User' });
}

/** Resolve the authenticated user for a request, or null. */
export function sessionUser(
  c: Context,
  db: Pick<IdentityRepository, 'getSessionUser' | 'upsertUserFromGitHub'>,
  config: Pick<SessionBrowserConfig, 'authDisabled'>,
): User | null {
  if (config.authDisabled) return developmentUser(db);
  const sessionId = getCookie(c, SESSION_COOKIE);
  return sessionId ? db.getSessionUser(sessionId) : null;
}

export function loginRedirect(c: Context, next: string): Response {
  return c.redirect(`/auth/login?next=${encodeURIComponent(next)}`);
}

export function setSessionCookie(
  c: Context,
  sessionId: string,
  config: Pick<SessionBrowserConfig, 'appUrl' | 'platformSecret'>,
): void {
  new RequestSecurity(config).setSession(c, sessionId);
}

/** Bind destructive sign-out requests to the active browser session. */
export function logoutCsrfToken(
  c: Context,
  config: Pick<SessionBrowserConfig, 'appUrl' | 'platformSecret'>,
): string | null {
  return new RequestSecurity(config).logoutCsrf(c);
}
