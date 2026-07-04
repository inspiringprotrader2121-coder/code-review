import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InstallStatePayload {
  tenantSlug: string;
  ts: number;
  /** user who initiated the connect flow; absent on pre-auth legacy states */
  userId?: string;
}

export function signInstallState(payload: InstallStatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyInstallState(state: string, secret: string, maxAgeMs = 3_600_000): InstallStatePayload | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: InstallStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as InstallStatePayload;
  } catch {
    return null;
  }

  if (!payload.tenantSlug || !payload.ts) return null;
  if (Date.now() - payload.ts > maxAgeMs) return null;

  return payload;
}

export function platformSecret(): string {
  const secret = process.env.PLATFORM_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('PLATFORM_SECRET or GITHUB_WEBHOOK_SECRET is required for install state signing');
  }
  return secret;
}
