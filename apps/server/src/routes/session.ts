import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createAppDatabase, type AppDatabase, type User } from '@orvex-review/store';
import {
  appPublicUrl,
  authDisabled,
  buildAuthorizeUrl,
  buildGoogleAuthorizeUrl,
  decryptTotpSecret,
  exchangeCodeForUser,
  exchangeGoogleCodeForUser,
  hashPassword,
  isDisposableEmail,
  normalizeEmail,
  loadOAuthConfigFromEnv,
  loadGoogleOAuthConfigFromEnv,
  type OAuthProvider,
  platformSecret,
  recoveryCodeMatches,
  signOAuthState,
  verifyOAuthState,
  verifyPassword,
  verifyTotpCodeWithEpoch,
} from '@orvex-review/tenants';
import { escapeHtml, pageShell } from './pages.js';
import { checkRateLimit, clearRateLimit } from './rate-limit.js';

/** Email/password login is active whenever any password account exists. */
function passwordAuthEnabled(db: AppDatabase): boolean {
  return process.env.ORVEX_REQUIRE_LOGIN === '1' || db.hasPasswordUsers();
}

export const SESSION_COOKIE = 'orvex_session';
const MFA_CHALLENGE_COOKIE = 'orvex_mfa_challenge';
const LOGIN_CSRF_COOKIE = 'orvex_login_csrf';
const SESSION_TTL_S = 30 * 24 * 3600;
// A valid scrypt hash to verify against when no real account/hash exists, so the
// failure path does the SAME scrypt work as the success path (anti-enumeration).
const DUMMY_PASSWORD_HASH = hashPassword('orvex-login-timing-guard');
const LOGIN_WINDOW_MS = Number(process.env.ORVEX_LOGIN_RATE_WINDOW_MS ?? 15 * 60_000);
const LOGIN_IP_MAX = Number(process.env.ORVEX_LOGIN_RATE_IP_MAX ?? 20);
const LOGIN_ACCOUNT_MAX = Number(process.env.ORVEX_LOGIN_RATE_ACCOUNT_MAX ?? 5);
const MFA_WINDOW_MS = Number(process.env.ORVEX_MFA_RATE_WINDOW_MS ?? 10 * 60_000);
const MFA_MAX = Number(process.env.ORVEX_MFA_RATE_MAX ?? 5);
const MFA_IP_MAX = Number(process.env.ORVEX_MFA_RATE_IP_MAX ?? 20);
const REGISTER_WINDOW_MS = Number(process.env.ORVEX_REGISTER_RATE_WINDOW_MS ?? 60 * 60_000);
const REGISTER_IP_MAX = Number(process.env.ORVEX_REGISTER_RATE_IP_MAX ?? 10);
const REGISTER_EMAIL_MAX = Number(process.env.ORVEX_REGISTER_RATE_EMAIL_MAX ?? 3);

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

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: appPublicUrl().startsWith('https://'),
    maxAge: SESSION_TTL_S,
  });
}

/** Bind destructive sign-out requests to the active browser session. */
export function logoutCsrfToken(c: Context): string | null {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;
  return createHmac('sha256', platformSecret())
    .update(`orvex-logout-csrf-v1:${sessionId}`)
    .digest('base64url');
}

function setMfaChallengeCookie(c: Context, challengeId: string): void {
  setCookie(c, MFA_CHALLENGE_COOKIE, challengeId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/auth',
    secure: appPublicUrl().startsWith('https://'),
    maxAge: 5 * 60,
  });
}

function beginAuthenticatedSession(c: Context, db: AppDatabase, user: User, next: string): Response {
  const security = db.getUserSecurity(user.id);
  if (security.totpEnabled) {
    if (!security.totpSecretEncrypted) return c.json({ error: 'two-factor authentication is misconfigured' }, 500);
    const challenge = db.createMfaChallenge(user.id, next);
    setMfaChallengeCookie(c, challenge.id);
    return c.redirect('/auth/2fa');
  }
  const session = db.createSession(user.id);
  setSessionCookie(c, session.id);
  return c.redirect(postAuthDestination(db, user, next));
}

export function sessionRoutes() {
  const app = new Hono();
  const db = createAppDatabase();

  app.get('/auth/register', (c) => {
    const next = safeNext(c.req.query('next') ?? '/connect');
    if (authDisabled()) return c.redirect(next);
    const csrf = randomBytes(32).toString('base64url');
    setLoginCsrfCookie(c, csrf);
    return c.html(registerPage(next, c.req.query('error'), csrf, oauthOptions()));
  });

  app.post('/auth/register', async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const confirmPassword = String(body.confirmPassword ?? '');
    const next = safeNext(typeof body.next === 'string' ? body.next : '/connect');
    if (!validLoginCsrf(c, String(body.csrf ?? ''))) {
      const csrf = randomBytes(32).toString('base64url');
      setLoginCsrfCookie(c, csrf);
      return c.html(registerPage(next, 'csrf', csrf, oauthOptions()), 403);
    }
    if (body.acceptedTerms !== '1') {
      return c.html(registerPage(next, 'terms', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 400);
    }
    if (!isValidEmail(email)) return c.html(registerPage(next, 'email', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 400);
    if (password.length < 12 || password.length > 1_024) {
      return c.html(registerPage(next, 'password', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 400);
    }
    if (password !== confirmPassword) {
      return c.html(registerPage(next, 'match', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 400);
    }

    const ip = clientIp(c);
    const ipLimitKey = `register:ip:${ip}`;
    const accountLimitKey = `register:account:${createHash('sha256').update(email).digest('hex')}`;
    const ipLimit = checkRateLimit(ipLimitKey, { windowMs: REGISTER_WINDOW_MS, max: REGISTER_IP_MAX });
    const accountLimit = db.consumeAuthAttempt(accountLimitKey, {
      windowMs: REGISTER_WINDOW_MS,
      max: REGISTER_EMAIL_MAX,
    });
    if (!ipLimit.allowed || !accountLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds, 1);
      c.header('Retry-After', String(retryAfter));
      return c.html(registerPage(next, 'rate', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 429);
    }

    // Anti-abuse: block disposable/throwaway inboxes (farmers mint unlimited
    // "real" emails from them), and collapse aliases so one inbox = one account —
    // john.doe+1@gmail.com and johndoe@gmail.com can't be two free trials.
    if (isDisposableEmail(email)) {
      return c.html(registerPage(next, 'disposable', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 400);
    }
    const normEmail = normalizeEmail(email);
    // Neutral "exists" response for BOTH an exact match and an alias collision, so
    // the page can't be used to enumerate which normalized inbox is registered.
    if (db.getUserByEmail(email) || db.getUserByNormalizedEmail(normEmail)) {
      return c.html(registerPage(next, 'exists', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 409);
    }
    const user = db.createPasswordUser({ email, passwordHash: hashPassword(password), normalizedEmail: normEmail });
    if (!user) return c.html(registerPage(next, 'exists', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 409);

    return beginAuthenticatedSession(c, db, user, next);
  });

  app.get('/auth/login', (c) => {
    const next = safeNext(c.req.query('next'));

    if (authDisabled()) {
      const session = db.createSession(devUser(db).id);
      setSessionCookie(c, session.id);
      return c.redirect(next);
    }

    const loginCsrf = randomBytes(32).toString('base64url');
    setLoginCsrfCookie(c, loginCsrf);

    const options = oauthOptions();
    if (passwordAuthEnabled(db) || options.github || options.google) {
      const err = c.req.query('error');
      return c.html(loginPage(next, err, loginCsrf, options));
    }

    const oauth = loadOAuthConfigFromEnv();
    if (!oauth) {
      // No OAuth configured → /connect runs in legacy (no-login) mode; send
      // visitors there instead of dead-ending the signup flow.
      return c.redirect('/connect');
    }

    const state = signOAuthState({ ts: Date.now(), next, nonce: loginCsrf }, platformSecret());
    return c.redirect(buildAuthorizeUrl(oauth, oauthCallbackUrl(), state));
  });

  app.get('/auth/github', (c) => startOAuth(c, 'github'));
  app.get('/auth/google', (c) => startOAuth(c, 'google'));

  app.post('/auth/login', async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const next = safeNext(typeof body.next === 'string' ? body.next : undefined);
    if (!validLoginCsrf(c, String(body.csrf ?? ''))) {
      const loginCsrf = randomBytes(32).toString('base64url');
      setLoginCsrfCookie(c, loginCsrf);
      return c.html(loginPage(next, 'csrf', loginCsrf, oauthOptions()), 403);
    }
    const ip = clientIp(c);
    const ipLimitKey = `login:ip:${ip}`;
    const accountLimitKey = `login:account:${createHash('sha256').update(email || 'empty').digest('hex')}`;
    const ipLimit = checkRateLimit(ipLimitKey, { windowMs: LOGIN_WINDOW_MS, max: LOGIN_IP_MAX });
    const accountLimit = db.consumeAuthAttempt(accountLimitKey, {
      windowMs: LOGIN_WINDOW_MS,
      max: LOGIN_ACCOUNT_MAX,
    });
    if (!ipLimit.allowed || !accountLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds, 1);
      c.header('Retry-After', String(retryAfter));
      return c.html(loginPage(next, 'rate', getCookie(c, LOGIN_CSRF_COOKIE) ?? '', oauthOptions()), 429);
    }

    const user = email ? db.getUserByEmail(email) : null;
    const storedHash = user ? db.getPasswordHash(user.id) : null;
    // Always run the scrypt work — even when the account (or its password) doesn't
    // exist — against a dummy hash, so response time can't reveal which emails are
    // registered. Without this, a missing account returns near-instantly (no
    // scrypt) and leaks enumeration.
    const passwordOk = verifyPassword(password, storedHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !storedHash || !passwordOk) {
      return c.redirect(`/auth/login?error=1&next=${encodeURIComponent(next)}`);
    }
    clearRateLimit(ipLimitKey);
    db.clearAuthAttempts(accountLimitKey);
    return beginAuthenticatedSession(c, db, user, next);
  });

  app.get('/auth/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return oauthFailureRedirect(c, 'github');

    const payload = verifyOAuthState(state, platformSecret());
    if (!payload || payload.provider !== 'github') return oauthFailureRedirect(c, 'github');
    const loginCsrf = getCookie(c, LOGIN_CSRF_COOKIE);
    if (!loginCsrf || !safeEqual(loginCsrf, payload.nonce)) {
      return oauthFailureRedirect(c, 'github', payload.next);
    }
    deleteCookie(c, LOGIN_CSRF_COOKIE, { path: '/auth' });

    const oauth = loadOAuthConfigFromEnv();
    if (!oauth) return oauthFailureRedirect(c, 'github', payload.next);

    try {
      const ghUser = await exchangeCodeForUser(oauth, code, oauthCallbackUrl());
      const normalizedEmail = ghUser.email ? normalizeEmail(ghUser.email) : undefined;
      const user = db.upsertUserFromGitHub({ ...ghUser, normalizedEmail });
      if (normalizedEmail) db.setUserNormalizedEmailIfMissing(user.id, normalizedEmail);
      return beginAuthenticatedSession(c, db, user, safeNext(payload.next));
    } catch (err) {
      console.warn('[auth] GitHub OAuth callback failed:', err instanceof Error ? err.message : String(err));
      return oauthFailureRedirect(c, 'github', payload.next);
    }
  });

  app.get('/auth/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return oauthFailureRedirect(c, 'google');
    const payload = verifyOAuthState(state, platformSecret());
    if (!payload || payload.provider !== 'google') return oauthFailureRedirect(c, 'google');
    const loginCsrf = getCookie(c, LOGIN_CSRF_COOKIE);
    if (!loginCsrf || !safeEqual(loginCsrf, payload.nonce)) {
      return oauthFailureRedirect(c, 'google', payload.next);
    }
    deleteCookie(c, LOGIN_CSRF_COOKIE, { path: '/auth' });
    const oauth = loadGoogleOAuthConfigFromEnv();
    if (!oauth) return oauthFailureRedirect(c, 'google', payload.next);
    try {
      const googleUser = await exchangeGoogleCodeForUser(oauth, code, googleOAuthCallbackUrl());
      const normalizedEmail = normalizeEmail(googleUser.email);
      const user = db.upsertUserFromGoogle({ ...googleUser, normalizedEmail });
      db.setUserNormalizedEmailIfMissing(user.id, normalizedEmail);
      return beginAuthenticatedSession(c, db, user, safeNext(payload.next));
    } catch (err) {
      console.warn('[auth] Google OAuth callback failed:', err instanceof Error ? err.message : String(err));
      return oauthFailureRedirect(c, 'google', payload.next);
    }
  });

  app.get('/auth/2fa', (c) => {
    const challengeId = getCookie(c, MFA_CHALLENGE_COOKIE);
    const challenge = challengeId ? db.getMfaChallenge(challengeId) : null;
    if (!challenge) {
      deleteCookie(c, MFA_CHALLENGE_COOKIE, { path: '/auth' });
      return c.redirect('/auth/login');
    }
    return c.html(mfaPage(c.req.query('error')));
  });

  app.post('/auth/2fa', async (c) => {
    const challengeId = getCookie(c, MFA_CHALLENGE_COOKIE);
    const challenge = challengeId ? db.getMfaChallenge(challengeId) : null;
    if (!challenge) {
      deleteCookie(c, MFA_CHALLENGE_COOKIE, { path: '/auth' });
      return c.redirect('/auth/login');
    }

    const ipLimitKey = `mfa:ip:${clientIp(c)}`;
    const ipLimit = checkRateLimit(ipLimitKey, { windowMs: MFA_WINDOW_MS, max: MFA_IP_MAX });
    const accountLimit = db.consumeMfaAttempt(challenge.userId, { windowMs: MFA_WINDOW_MS, max: MFA_MAX });
    if (!ipLimit.allowed || !accountLimit.allowed) {
      c.header('Retry-After', String(Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds, 1)));
      return c.html(mfaPage('rate'), 429);
    }

    const body = await c.req.parseBody();
    const code = String(body.code ?? '').trim();
    const security = db.getUserSecurity(challenge.userId);
    const encrypted = security.totpSecretEncrypted;
    const secret = encrypted ? decryptTotpSecret(encrypted, platformSecret()) : null;
    const totp = secret ? await verifyTotpCodeWithEpoch(secret, code) : { valid: false as const };
    const matchedRecoveryHash = security.recoveryCodeHashes.find((hash) =>
      recoveryCodeMatches(hash, challenge.userId, code, platformSecret()),
    );
    const factor = totp.valid && totp.epoch !== undefined
      ? { totpEpoch: totp.epoch }
      : matchedRecoveryHash
        ? { recoveryCodeHash: matchedRecoveryHash }
        : null;
    if (!security.totpEnabled || !factor) {
      return c.redirect('/auth/2fa?error=1');
    }

    const completed = db.completeMfaChallenge(challenge.id, factor);
    if (!completed) return c.redirect('/auth/2fa?error=1');
    clearRateLimit(ipLimitKey);
    deleteCookie(c, MFA_CHALLENGE_COOKIE, { path: '/auth' });
    setSessionCookie(c, completed.session.id);
    const user = db.getUserById(completed.challenge.userId);
    return c.redirect(user ? postAuthDestination(db, user, completed.challenge.next) : safeNext(completed.challenge.next));
  });

  app.get('/auth/logout', (c) => {
    const user = sessionUser(c, db);
    const csrf = logoutCsrfToken(c);
    if (!user || !csrf) return c.redirect('/auth/login');
    return c.html(logoutPage(csrf));
  });

  app.post('/auth/logout', async (c) => {
    const body = await c.req.parseBody();
    const expectedCsrf = logoutCsrfToken(c);
    if (!expectedCsrf || !safeEqual(String(body.csrf ?? ''), expectedCsrf)) {
      return c.text('Invalid security token', 403);
    }
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) db.deleteSession(sid);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/connect');
  });

  app.get('/api/me', (c) => {
    const user = sessionUser(c, db);
    if (!user) return c.json({ error: 'not signed in' }, 401);
    return c.json({
      user: {
        id: user.id,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        isSuperAdmin: user.isSuperAdmin,
        totpEnabled: db.getUserSecurity(user.id).totpEnabled,
      },
      workspaces: db.getWorkspacesForUser(user.id).map((w) => ({
        slug: w.tenant.slug,
        name: w.tenant.name,
        role: w.role,
      })),
    });
  });

  return app;

  function oauthOptions() {
    return {
      github: Boolean(loadOAuthConfigFromEnv()),
      google: Boolean(loadGoogleOAuthConfigFromEnv()),
    };
  }

  function startOAuth(c: Context, provider: OAuthProvider): Response {
    const next = safeNext(c.req.query('next') ?? '/connect');
    const csrf = getCookie(c, LOGIN_CSRF_COOKIE) ?? randomBytes(32).toString('base64url');
    if (!getCookie(c, LOGIN_CSRF_COOKIE)) setLoginCsrfCookie(c, csrf);
    const state = signOAuthState({ ts: Date.now(), next, nonce: csrf, provider }, platformSecret());
    if (provider === 'github') {
      const oauth = loadOAuthConfigFromEnv();
      return oauth ? c.redirect(buildAuthorizeUrl(oauth, oauthCallbackUrl(), state)) : c.redirect('/auth/login?error=github');
    }
    const oauth = loadGoogleOAuthConfigFromEnv();
    return oauth ? c.redirect(buildGoogleAuthorizeUrl(oauth, googleOAuthCallbackUrl(), state)) : c.redirect('/auth/login?error=google');
  }
}

function oauthCallbackUrl(): string {
  return `${appPublicUrl()}/auth/oauth/callback`;
}

function googleOAuthCallbackUrl(): string {
  return `${appPublicUrl()}/auth/google/callback`;
}

/** Best-effort client IP behind the nginx proxy. */
function clientIp(c: Context): string {
  const realIp = c.req.header('x-real-ip');
  if (realIp?.trim()) return realIp.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return 'unknown';
}

function setLoginCsrfCookie(c: Context, token: string): void {
  setCookie(c, LOGIN_CSRF_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/auth',
    secure: appPublicUrl().startsWith('https://'),
    maxAge: 10 * 60,
  });
}

function validLoginCsrf(c: Context, submitted: string): boolean {
  const cookie = getCookie(c, LOGIN_CSRF_COOKIE);
  return Boolean(cookie && submitted && safeEqual(cookie, submitted));
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
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

function oauthFailureRedirect(c: Context, provider: 'github' | 'google', next?: string): Response {
  return c.redirect(`/auth/login?error=${provider}&next=${encodeURIComponent(safeNext(next))}`);
}

/** Existing workspace members should not be sent back into the onboarding flow. */
function postAuthDestination(db: AppDatabase, user: User, next: string | undefined): string {
  const destination = safeNext(next);
  return destination === '/connect' && db.getWorkspacesForUser(user.id).length > 0
    ? '/dashboard'
    : destination;
}

function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function loginPage(
  next: string,
  error: string | undefined,
  csrf: string,
  options: { github: boolean; google: boolean },
): string {
  const nextAttr = escapeHtml(next);
  const banner =
    error === 'rate'
      ? '<div class="banner error">Too many sign-in attempts. Try again in a few minutes.</div>'
      : error === 'csrf'
        ? '<div class="banner error">Your sign-in form expired. Please try again.</div>'
        : error === 'github'
          ? '<div class="banner error">GitHub sign-in was cancelled or could not be completed. Try again.</div>'
          : error === 'google'
            ? '<div class="banner error">Google sign-in was cancelled or could not be completed. Try again.</div>'
        : error
        ? '<div class="banner error">Incorrect email or password.</div>'
        : '';
  return pageShell(
    'Sign in',
    `<h1>Sign in to Orvex</h1>
     <p class="lead">Access your review dashboard and connected GitHub.</p>
     ${banner}
     ${socialAuthButtons(next, options)}
     <form method="post" action="/auth/login">
       <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
       <input type="hidden" name="next" value="${nextAttr}" />
       <label for="email">Email</label>
       <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@example.com" />
     <label for="password">Password</label>
     <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••" />
     <button type="submit">Sign in →</button>
     </form>
     <p class="muted" style="margin-top:16px">New to Orvex? <a href="/auth/register?next=${encodeURIComponent(next)}">Create a free account</a></p>`,
  );
}

function registerPage(
  next: string,
  error: string | undefined,
  csrf: string,
  options: { github: boolean; google: boolean },
): string {
  const banner =
    error === 'rate'
      ? '<div class="banner error">Too many account-creation attempts. Try again later.</div>'
      : error === 'csrf'
        ? '<div class="banner error">Your registration form expired. Please try again.</div>'
        : error === 'email'
          ? '<div class="banner error">Enter a valid email address.</div>'
          : error === 'password'
            ? '<div class="banner error">Use a password between 12 and 1,024 characters.</div>'
            : error === 'match'
              ? '<div class="banner error">The passwords do not match.</div>'
              : error === 'exists'
                ? '<div class="banner error">An account already exists for that email. Please sign in.</div>'
                : error === 'disposable'
                  ? '<div class="banner error">Please use a permanent email address — disposable/temporary inboxes aren\'t accepted.</div>'
                  : error === 'terms'
                    ? '<div class="banner error">Please accept the Terms of Service and Privacy Policy to create an account.</div>'
                  : '';
  return pageShell(
    'Create your account',
    `<h1>Start free with Orvex</h1>
     <p class="lead">Create your account, then connect the GitHub repositories you want reviewed.</p>
     ${banner}
     ${socialAuthButtons(next, options)}
     <form method="post" action="/auth/register">
       <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
       <input type="hidden" name="next" value="${escapeHtml(next)}" />
       <label for="email">Email</label>
       <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" />
       <label for="password">Password</label>
       <input id="password" name="password" type="password" required minlength="12" autocomplete="new-password" />
       <p class="hint">At least 12 characters.</p>
       <label for="confirm-password">Confirm password</label>
       <input id="confirm-password" name="confirmPassword" type="password" required minlength="12" autocomplete="new-password" />
       <label style="display:flex;align-items:flex-start;gap:8px;margin-top:14px;font-size:13px;line-height:1.45">
         <input id="accepted-terms" name="acceptedTerms" value="1" type="checkbox" required style="margin-top:3px" />
         <span>I agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>
         and acknowledge the <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</span>
       </label>
       <button type="submit">Create free account →</button>
     </form>
     <p class="muted" style="margin-top:16px">Already have an account? <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in</a></p>`,
  );
}

function socialAuthButtons(next: string, options: { github: boolean; google: boolean }): string {
  const nextQuery = encodeURIComponent(next);
  const buttons = [
    options.google ? `<a class="btn secondary" href="/auth/google?next=${nextQuery}">Continue with Google</a>` : '',
    options.github ? `<a class="btn secondary" href="/auth/github?next=${nextQuery}">Continue with GitHub</a>` : '',
  ].filter(Boolean).join('');
  return buttons ? `${buttons}<p class="muted" style="text-align:center;margin:14px 0 -4px">or use your email</p>` : '';
}

function mfaPage(error?: string): string {
  const banner =
    error === 'rate'
      ? '<div class="banner error">Too many attempts. Try again in a few minutes.</div>'
      : error
        ? '<div class="banner error">That authentication code was not accepted.</div>'
        : '';
  return pageShell(
    'Two-factor authentication',
    `<h1>Authentication code</h1>
     <p class="lead">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
     ${banner}
     <form method="post" action="/auth/2fa">
       <label for="code">Authentication code</label>
       <input id="code" name="code" type="text" required autofocus autocapitalize="characters" spellcheck="false" autocomplete="one-time-code" />
       <button type="submit">Continue</button>
     </form>`,
  );
}

function logoutPage(csrf: string): string {
  return pageShell(
    'Sign out',
    `<h1>Sign out of Orvex?</h1>
     <p class="lead">You will need to sign in again to access your review dashboard.</p>
     <form method="post" action="/auth/logout">
       <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
       <button type="submit">Sign out</button>
     </form>`,
  );
}
