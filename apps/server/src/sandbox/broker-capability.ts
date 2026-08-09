import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';

const CAPABILITY_PREFIX = 'orvex1';
const MAX_CAPABILITY_TTL_MS = 30 * 60_000;
const CAPABILITY_REQUEST_LIMIT = 32;

export function brokerSigningKeyPath(uid = process.getuid?.()): string {
  if (uid === undefined) throw new Error('broker capability signing requires a POSIX uid');
  return `/run/user/${uid}/orvex-agentic-egress/broker-signing-key`;
}

export function readBrokerSigningKey(file = brokerSigningKeyPath()): string {
  const stat = fs.lstatSync(file);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 32 ||
    stat.size > 1_024
  ) {
    throw new Error('broker capability signing key is not a private service-account file');
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (key.length < 32 || /[\r\n\0]/.test(key)) {
    throw new Error('broker capability signing key is malformed');
  }
  return key;
}

export function createBrokerCapabilityToken(
  runTimeoutMs: number,
  options: { now?: number; signingKey?: string; jti?: string; maxRequests?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const ttlMs = Math.min(MAX_CAPABILITY_TTL_MS, Math.max(60_000, runTimeoutMs + 60_000));
  const payload = {
    jti: options.jti ?? randomUUID(),
    exp: Math.floor((now + ttlMs) / 1_000),
    maxRequests: options.maxRequests ?? CAPABILITY_REQUEST_LIMIT,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsigned = `${CAPABILITY_PREFIX}.${body}`;
  const signature = createHmac('sha256', options.signingKey ?? readBrokerSigningKey())
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

export function isBrokerCapabilityToken(value: string | undefined): value is string {
  return Boolean(
    value && value.length <= 2_048 && /^orvex1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value),
  );
}
