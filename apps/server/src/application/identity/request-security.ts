import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'orvex_session';
export const LOGIN_CSRF_COOKIE = 'orvex_login_csrf';
export const MFA_CHALLENGE_COOKIE = 'orvex_mfa_challenge';

export type RequestSecurityConfig = {
  appUrl: string;
  platformSecret: string;
  trustedProxyIps?: readonly string[];
};

type NodeSocketBindings = Readonly<{
  incoming?: Readonly<{ socket?: Readonly<{ remoteAddress?: string }> }>;
  server?: Readonly<{
    incoming?: Readonly<{ socket?: Readonly<{ remoteAddress?: string }> }>;
  }>;
}>;

export class RequestSecurity {
  constructor(private readonly config: RequestSecurityConfig) {}

  safeNext(next: string | undefined): string {
    if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
      return '/dashboard';
    return next;
  }

  fullPath(url: string): string {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }

  clientIp(c: Context): string {
    const socketIp = this.socketIp(c);
    if (!socketIp || !this.isTrustedProxy(socketIp)) return socketIp ?? 'unknown';

    const realIp = validIp(c.req.header('x-real-ip'));
    if (realIp) return realIp;
    const forwarded = c.req.header('x-forwarded-for');
    const firstForwardedIp = forwarded?.split(',', 1)[0];
    return validIp(firstForwardedIp) ?? socketIp;
  }

  sameOrigin(c: Context): boolean {
    try {
      const expected = new URL(this.config.appUrl).origin;
      const origin = c.req.header('origin');
      if (origin) return origin === expected;
      const referer = c.req.header('referer');
      return Boolean(referer && new URL(referer).origin === expected);
    } catch {
      return false;
    }
  }

  issueLoginCsrf(c: Context): string {
    const token = randomBytes(32).toString('base64url');
    setCookie(c, LOGIN_CSRF_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/auth',
      secure: this.isSecure(),
      maxAge: 10 * 60,
    });
    return token;
  }

  loginCsrf(c: Context): string | undefined {
    return getCookie(c, LOGIN_CSRF_COOKIE);
  }

  validLoginCsrf(c: Context, submitted: string): boolean {
    const token = this.loginCsrf(c);
    return Boolean(token && submitted && this.safeEqual(token, submitted));
  }

  clearLoginCsrf(c: Context): void {
    deleteCookie(c, LOGIN_CSRF_COOKIE, { path: '/auth' });
  }

  sessionCsrf(c: Context): string {
    const sessionId = getCookie(c, SESSION_COOKIE) ?? '';
    return createHmac('sha256', this.config.platformSecret)
      .update(`orvex-csrf-v1:${sessionId}`)
      .digest('base64url');
  }

  async validSessionCsrf(c: Context): Promise<boolean> {
    let submitted = c.req.header('x-orvex-csrf');
    if (!submitted) {
      try {
        const form = await c.req.raw.clone().formData();
        const value = form.get('csrf');
        if (typeof value === 'string') submitted = value;
      } catch {
        return false;
      }
    }
    return Boolean(submitted && this.safeEqual(submitted, this.sessionCsrf(c)));
  }

  logoutCsrf(c: Context): string | null {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (!sessionId) return null;
    return createHmac('sha256', this.config.platformSecret)
      .update(`orvex-logout-csrf-v1:${sessionId}`)
      .digest('base64url');
  }

  validLogoutCsrf(c: Context, submitted: string): boolean {
    const expected = this.logoutCsrf(c);
    return Boolean(expected && this.safeEqual(submitted, expected));
  }

  setSession(c: Context, sessionId: string): void {
    setCookie(c, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: this.isSecure(),
      maxAge: 30 * 24 * 3600,
    });
  }

  clearSession(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
  }

  setMfaChallenge(c: Context, challengeId: string): void {
    setCookie(c, MFA_CHALLENGE_COOKIE, challengeId, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/auth',
      secure: this.isSecure(),
      maxAge: 5 * 60,
    });
  }

  mfaChallenge(c: Context): string | undefined {
    return getCookie(c, MFA_CHALLENGE_COOKIE);
  }

  clearMfaChallenge(c: Context): void {
    deleteCookie(c, MFA_CHALLENGE_COOKIE, { path: '/auth' });
  }

  private isSecure(): boolean {
    return this.config.appUrl.startsWith('https://');
  }

  private isTrustedProxy(socketIp: string): boolean {
    return (this.config.trustedProxyIps ?? []).includes(socketIp);
  }

  private socketIp(c: Context): string | undefined {
    // @hono/node-server puts IncomingMessage in c.env (or c.env.server). Unit
    // tests and Fetch-only runtimes have no socket, which intentionally falls
    // back to an opaque IP key rather than trusting client-supplied headers.
    const bindings = (c as unknown as { env?: NodeSocketBindings }).env;
    const address =
      bindings?.server?.incoming?.socket?.remoteAddress ??
      bindings?.incoming?.socket?.remoteAddress;
    return validIp(address);
  }

  private safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function validIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}
