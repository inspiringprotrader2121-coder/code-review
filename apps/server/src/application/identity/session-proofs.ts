import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { OAuthProvider } from '@orvex-review/tenants';

const GITHUB_INSTALL_PROOF_COOKIE = 'orvex_github_install_proof';
const OAUTH_REAUTH_PROOF_COOKIE = 'orvex_oauth_reauth_proof';
const PROOF_TTL_MS = 10 * 60_000;
const MAX_RECENT_GITHUB_ACCESS_TOKENS = 10_000;
const recentGitHubAccessTokens = new Map<string, { token: string; expiresAt: number }>();

export type SessionProofConfig = Readonly<{ appUrl: string; platformSecret: string }>;

/** Keep OAuth proof only long enough to authorize the subsequent App install. */
export function rememberGitHubAccessToken(userId: string, token: string): void {
  const now = Date.now();
  for (const [id, entry] of recentGitHubAccessTokens) {
    if (entry.expiresAt <= now) recentGitHubAccessTokens.delete(id);
  }
  recentGitHubAccessTokens.set(userId, { token, expiresAt: now + PROOF_TTL_MS });
  while (recentGitHubAccessTokens.size > MAX_RECENT_GITHUB_ACCESS_TOKENS) {
    const oldest = recentGitHubAccessTokens.keys().next().value as string | undefined;
    if (!oldest) break;
    recentGitHubAccessTokens.delete(oldest);
  }
}

export function recentGitHubAccessToken(userId: string): string | undefined {
  const entry = recentGitHubAccessTokens.get(userId);
  if (!entry || entry.expiresAt <= Date.now()) {
    recentGitHubAccessTokens.delete(userId);
    return undefined;
  }
  return entry.token;
}

export function setGitHubInstallProof(
  c: Context,
  userId: string,
  token: string,
  config: SessionProofConfig,
): void {
  writeProof(
    c,
    GITHUB_INSTALL_PROOF_COOKIE,
    { userId, token, expiresAt: Date.now() + PROOF_TTL_MS },
    config,
    600,
  );
}

export function peekGitHubInstallProof(
  c: Context,
  userId: string,
  config: SessionProofConfig,
): string | undefined {
  const payload = readProof(c, GITHUB_INSTALL_PROOF_COOKIE, false, config);
  return isGitHubProof(payload, userId) ? payload.token : undefined;
}

export function consumeGitHubInstallProof(
  c: Context,
  userId: string,
  config: SessionProofConfig,
): string | undefined {
  const payload = readProof(c, GITHUB_INSTALL_PROOF_COOKIE, true, config);
  return isGitHubProof(payload, userId) ? payload.token : undefined;
}

export function setOAuthReauthProof(
  c: Context,
  userId: string,
  provider: OAuthProvider,
  config: SessionProofConfig,
): void {
  writeProof(
    c,
    OAUTH_REAUTH_PROOF_COOKIE,
    { userId, provider, expiresAt: Date.now() + PROOF_TTL_MS },
    config,
    600,
  );
}

export function peekOAuthReauthProof(
  c: Context,
  userId: string,
  config: SessionProofConfig,
): boolean {
  return isReauthProof(readProof(c, OAUTH_REAUTH_PROOF_COOKIE, false, config), userId);
}

export function consumeOAuthReauthProof(
  c: Context,
  userId: string,
  config: SessionProofConfig,
): boolean {
  return isReauthProof(readProof(c, OAUTH_REAUTH_PROOF_COOKIE, true, config), userId);
}

type ProofPayload = { userId?: unknown; token?: unknown; provider?: unknown; expiresAt?: unknown };

function writeProof(
  c: Context,
  name: string,
  payload: ProofPayload,
  config: SessionProofConfig,
  maxAge: number,
): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', proofKey(config), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  setCookie(c, name, sealed, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: config.appUrl.startsWith('https://'),
    maxAge,
  });
}

function readProof(
  c: Context,
  name: string,
  consume: boolean,
  config: SessionProofConfig,
): ProofPayload | null {
  const sealed = getCookie(c, name);
  if (consume) deleteCookie(c, name, { path: '/' });
  if (!sealed) return null;
  try {
    const bytes = Buffer.from(sealed, 'base64url');
    if (bytes.length <= 28) return null;
    const decipher = createDecipheriv('aes-256-gcm', proofKey(config), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    ) as ProofPayload;
  } catch {
    return null;
  }
}

function isGitHubProof(
  payload: ProofPayload | null,
  userId: string,
): payload is { userId: string; token: string; expiresAt: number } {
  return Boolean(
    payload &&
      payload.userId === userId &&
      typeof payload.token === 'string' &&
      payload.token.trim() &&
      isLiveExpiry(payload.expiresAt),
  );
}

function isReauthProof(payload: ProofPayload | null, userId: string): boolean {
  return Boolean(
    payload &&
      payload.userId === userId &&
      (payload.provider === 'github' || payload.provider === 'google') &&
      isLiveExpiry(payload.expiresAt),
  );
}

function isLiveExpiry(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > Date.now();
}

function proofKey(config: Pick<SessionProofConfig, 'platformSecret'>): Buffer {
  return createHash('sha256')
    .update(`orvex-github-install-proof:${config.platformSecret}`)
    .digest();
}
