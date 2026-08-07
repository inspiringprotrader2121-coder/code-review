import type { Context } from 'hono';

/** Require a browser mutation to originate from the configured application. */
export function sameOriginRequest(c: Context): boolean {
  try {
    // Never derive the trusted origin from the request URL/Host header. When
    // APP_URL was absent, an attacker-controlled Host could make its own
    // Origin appear same-origin and bypass the browser mutation gate.
    // Keep local development usable with the fixed localhost fallback, while
    // production deployments should always set APP_URL to their public origin.
    const configuredAppUrl =
      process.env.APP_URL?.trim() || `http://localhost:${process.env.PORT ?? 8787}`;
    const expected = new URL(configuredAppUrl).origin;
    const origin = c.req.header('origin');
    if (origin) return origin === expected;
    const referer = c.req.header('referer');
    return Boolean(referer && new URL(referer).origin === expected);
  } catch {
    return false;
  }
}
