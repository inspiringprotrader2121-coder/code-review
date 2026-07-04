import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createAppDatabase, type AppDatabase, type User } from '@orvex-review/store';
import {
  appPublicUrl,
  authDisabled,
  buildAuthorizeUrl,
  exchangeCodeForUser,
  loadOAuthConfigFromEnv,
  platformSecret,
  signOAuthState,
  verifyOAuthState,
} from '@orvex-review/tenants';

export const SESSION_COOKIE = 'orvex_session';
const SESSION_TTL_S = 30 * 24 * 3600;

function devUser(db: AppDatabase): User {
  return db.upsertUserFromGitHub({ githubId: 0, login: 'dev', name: 'Dev User' });
}

/** Resolve the authenticated user for a request, or null. */
export function sessionUser(c: Context, db: AppDatabase): User | null {
  if (authDisabled()) return devUser(db);
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return null;
  return db.getSessionUser(sid);
}

export function loginRedirect(c: Context, next: string) {
  return c.redirect(`/auth/login?next=${encodeURIComponent(next)}`);
}

function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: appPublicUrl().startsWith('https://'),
    maxAge: SESSION_TTL_S,
  });
}

export function sessionRoutes() {
  const app = new Hono();
  const db = createAppDatabase();

  app.get('/auth/login', (c) => {
    const next = safeNext(c.req.query('next'));

    if (authDisabled()) {
      const session = db.createSession(devUser(db).id);
      setSessionCookie(c, session.id);
      return c.redirect(next);
    }

    const oauth = loadOAuthConfigFromEnv();
    if (!oauth) {
      return c.json(
        {
          error: 'user login is not configured',
          hint: 'Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET from the GitHub App settings page, or AUTH_DISABLED=1 for local development.',
        },
        501,
      );
    }

    const state = signOAuthState({ ts: Date.now(), next }, platformSecret());
    return c.redirect(buildAuthorizeUrl(oauth, oauthCallbackUrl(), state));
  });

  app.get('/auth/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.json({ error: 'missing code or state' }, 400);

    const payload = verifyOAuthState(state, platformSecret());
    if (!payload) return c.json({ error: 'invalid or expired state' }, 400);

    const oauth = loadOAuthConfigFromEnv();
    if (!oauth) return c.json({ error: 'user login is not configured' }, 501);

    try {
      const ghUser = await exchangeCodeForUser(oauth, code, oauthCallbackUrl());
      const user = db.upsertUserFromGitHub(ghUser);
      const session = db.createSession(user.id);
      setSessionCookie(c, session.id);
      return c.redirect(safeNext(payload.next));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/auth/logout', (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) db.deleteSession(sid);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/connect');
  });

  app.get('/api/me', (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.json({ error: 'not signed in' }, 401);
    return c.json({
      user: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl },
      workspaces: db.getWorkspacesForUser(user.id).map((w) => ({
        slug: w.tenant.slug,
        name: w.tenant.name,
        role: w.role,
      })),
    });
  });

  return app;
}

function oauthCallbackUrl(): string {
  return `${appPublicUrl()}/auth/oauth/callback`;
}

/** Only allow same-site relative redirect targets. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/connect';
  return next;
}
