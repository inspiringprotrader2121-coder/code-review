import type { Context } from 'hono';
import { RequestSecurity } from '../application/identity/request-security.js';
import type { ServerConfig } from '../bootstrap/config.js';

export function requestSecurity(
  config: Pick<ServerConfig, 'appUrl' | 'identity' | 'platformSecret'>,
): RequestSecurity {
  return new RequestSecurity({
    appUrl: config.appUrl,
    platformSecret: config.platformSecret,
    trustedProxyIps: config.identity.trustedProxyIps,
  });
}

/** Compatibility route adapter. New code should depend on RequestSecurity. */
export function sameOriginRequest(
  c: Context,
  config: Pick<ServerConfig, 'appUrl' | 'platformSecret'>,
): boolean {
  return new RequestSecurity(config).sameOrigin(c);
}
