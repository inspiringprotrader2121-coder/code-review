import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';

const TOTP_ISSUER = 'Orvex';
const ENCRYPTION_VERSION = 'v1';

export function generateTotpSecret(): string {
  return generateSecret();
}

export function totpEnrollmentUri(accountLabel: string, secret: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: accountLabel, secret });
}

export async function verifyTotpCode(secret: string, token: string): Promise<boolean> {
  return (await verifyTotpCodeWithEpoch(secret, token)).valid;
}

export async function verifyTotpCodeWithEpoch(
  secret: string,
  token: string,
): Promise<{ valid: boolean; epoch?: number }> {
  const normalized = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return { valid: false };
  try {
    const result = await verify({ secret, token: normalized, epochTolerance: 30 });
    return result.valid && 'epoch' in result
      ? { valid: true, epoch: result.epoch }
      : { valid: false };
  } catch {
    return { valid: false };
  }
}

export function encryptTotpSecret(secret: string, masterSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(masterSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptTotpSecret(encrypted: string, masterSecret: string): string | null {
  const [version, ivRaw, tagRaw, ciphertextRaw] = encrypted.split('.');
  if (version !== ENCRYPTION_VERSION || !ivRaw || !tagRaw || !ciphertextRaw) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(masterSecret), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(8).toString('hex').toUpperCase();
    return raw.match(/.{1,4}/g)!.join('-');
  });
}

export function hashRecoveryCode(userId: string, code: string, masterSecret: string): string {
  return createHmac('sha256', masterSecret)
    .update(`orvex-recovery-v1:${userId}:${normalizeRecoveryCode(code)}`)
    .digest('hex');
}

export function recoveryCodeMatches(expectedHash: string, userId: string, code: string, masterSecret: string): boolean {
  const actual = Buffer.from(hashRecoveryCode(userId, code, masterSecret));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function encryptionKey(masterSecret: string): Buffer {
  return createHash('sha256').update('orvex-totp-encryption-v1\0').update(masterSecret).digest();
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
