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
  verifyPassword,
} from '@orvex-review/tenants';
import { pageShell } from './pages.js';

/** Email/password login is active whenever any password account exists. */
function passwordAuthEnabled(db: AppDatabase): boolean {
  return process.env.ORVEX_REQUIRE_LOGIN === '1' || db.hasPasswordUsers();
}

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

    // Email/password login page
    if (passwordAuthEnabled(db)) {
      const err = c.req.query('error');
      return c.html(loginPage(next, err));
    }

    const oauth = loadOAuthConfigFromEnv();
    if (!oauth) {
      // No OAuth configured → /connect runs in legacy (no-login) mode; send
      // visitors there instead of dead-ending the signup flow.
      return c.redirect('/connect');
    }

    const state = signOAuthState({ ts: Date.now(), next }, platformSecret());
    return c.redirect(buildAuthorizeUrl(oauth, oauthCallbackUrl(), state));
  });

  app.post('/auth/login', async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const next = safeNext(typeof body.next === 'string' ? body.next : undefined);

    const user = email ? db.getUserByEmail(email) : null;
    if (!user || !verifyPassword(password, db.getPasswordHash(user.id))) {
      return c.redirect(`/auth/login?error=1&next=${encodeURIComponent(next)}`);
    }
    const session = db.createSession(user.id);
    setSessionCookie(c, session.id);
    return c.redirect(next);
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
  // Reject anything not starting with a single '/', protocol-relative '//…', OR
  // containing a backslash — several browsers normalize '\' → '/', so '/\evil.com'
  // becomes protocol-relative and redirects off-site after login.
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return '/dashboard';
  }
  return next;
}

function loginPage(next: string, error?: string): string {
  const nextAttr = next.replace(/"/g, '&quot;');
  const banner = error ? '<div class="banner error">Incorrect email or password.</div>' : '';
  return pageShell(
    'Sign in',
    `<h1>Sign in to Orvex</h1>
     <p class="lead">Access your review dashboard and connected GitHub.</p>
     ${banner}
     <form method="post" action="/auth/login">
       <input type="hidden" name="next" value="${nextAttr}" />
       <label for="email">Email</label>
       <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@example.com" />
       <label for="password">Password</label>
       <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••" />
       <button type="submit">Sign in →</button>
     </form>`,
  );
}
