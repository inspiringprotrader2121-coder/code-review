import type { IdentityRepository, UserSecurity } from '@orvex-review/store';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  recoveryCodeMatches,
  verifyPassword,
  verifyTotpCodeWithEpoch,
} from '@orvex-review/tenants';

export type AccountSecurityStore = Pick<
  IdentityRepository,
  | 'completeTotpEnrollment'
  | 'disableTotpAndRotateSession'
  | 'getPasswordHash'
  | 'getUserSecurity'
  | 'regenerateRecoveryCodesAndRotateSession'
  | 'setPendingTotpSecret'
>;

export type SecurityOperation =
  | { kind: 'ok'; sessionId?: string; recoveryCodes?: string[] }
  | {
      kind: 'already_enabled' | 'missing_pending_secret' | 'stale' | 'invalid' | 'reauth_required';
    };

/** MFA state transitions and credential checks, isolated from HTTP/cookie handling. */
export class AccountSecurityService {
  constructor(
    private readonly store: AccountSecurityStore,
    private readonly platformSecret: string,
  ) {}

  security(userId: string): UserSecurity {
    return this.store.getUserSecurity(userId);
  }

  beginEnrollment(userId: string, oauthReauthenticated: boolean): SecurityOperation {
    if (this.security(userId).totpEnabled) return { kind: 'already_enabled' };
    if (!this.store.getPasswordHash(userId) && !oauthReauthenticated)
      return { kind: 'reauth_required' };
    return this.store.setPendingTotpSecret(
      userId,
      encryptTotpSecret(generateTotpSecret(), this.platformSecret),
    )
      ? { kind: 'ok' }
      : { kind: 'stale' };
  }

  pendingSecret(userId: string): string | null {
    const encrypted = this.security(userId).totpSecretEncrypted;
    return encrypted ? decryptTotpSecret(encrypted, this.platformSecret) : null;
  }

  async verifyEnrollment(input: {
    userId: string;
    password: string;
    code: string;
    oauthReauthenticated: boolean;
  }): Promise<SecurityOperation> {
    const passwordHash = this.store.getPasswordHash(input.userId);
    const encrypted = this.security(input.userId).totpSecretEncrypted;
    const secret = encrypted ? decryptTotpSecret(encrypted, this.platformSecret) : null;
    const totp = secret
      ? await verifyTotpCodeWithEpoch(secret, input.code)
      : { valid: false as const };
    if (
      (passwordHash
        ? !verifyPassword(input.password, passwordHash)
        : !input.oauthReauthenticated) ||
      !totp.valid ||
      totp.epoch === undefined ||
      !encrypted
    ) {
      return { kind: 'invalid' };
    }
    const recoveryCodes = generateRecoveryCodes();
    const session = this.store.completeTotpEnrollment({
      userId: input.userId,
      expectedEncryptedSecret: encrypted,
      totpEpoch: totp.epoch,
      recoveryCodeHashes: recoveryCodes.map((code) =>
        hashRecoveryCode(input.userId, code, this.platformSecret),
      ),
    });
    return session ? { kind: 'ok', sessionId: session.id, recoveryCodes } : { kind: 'stale' };
  }

  async disable(input: {
    userId: string;
    password: string;
    code: string;
    oauthReauthenticated: boolean;
  }): Promise<SecurityOperation> {
    const security = this.security(input.userId);
    const passwordHash = this.store.getPasswordHash(input.userId);
    const secret = security.totpSecretEncrypted
      ? decryptTotpSecret(security.totpSecretEncrypted, this.platformSecret)
      : null;
    const totp = secret
      ? await verifyTotpCodeWithEpoch(secret, input.code)
      : { valid: false as const };
    const recoveryCodeHash = security.recoveryCodeHashes.find((hash) =>
      recoveryCodeMatches(hash, input.userId, input.code, this.platformSecret),
    );
    const factor =
      totp.valid && totp.epoch !== undefined
        ? { totpEpoch: totp.epoch }
        : recoveryCodeHash
          ? { recoveryCodeHash }
          : null;
    const reauthenticated = passwordHash
      ? verifyPassword(input.password, passwordHash)
      : input.oauthReauthenticated;
    if (!security.totpEnabled || !reauthenticated || !factor) return { kind: 'invalid' };
    const session = this.store.disableTotpAndRotateSession({ userId: input.userId, factor });
    return session ? { kind: 'ok', sessionId: session.id } : { kind: 'invalid' };
  }

  async regenerateRecoveryCodes(input: {
    userId: string;
    password: string;
    code: string;
    oauthReauthenticated: boolean;
  }): Promise<SecurityOperation> {
    const security = this.security(input.userId);
    const passwordHash = this.store.getPasswordHash(input.userId);
    const secret = security.totpSecretEncrypted
      ? decryptTotpSecret(security.totpSecretEncrypted, this.platformSecret)
      : null;
    const totp = secret
      ? await verifyTotpCodeWithEpoch(secret, input.code)
      : { valid: false as const };
    const reauthenticated = passwordHash
      ? verifyPassword(input.password, passwordHash)
      : input.oauthReauthenticated;
    if (!security.totpEnabled || !reauthenticated || !totp.valid || totp.epoch === undefined)
      return { kind: 'invalid' };
    const recoveryCodes = generateRecoveryCodes();
    const session = this.store.regenerateRecoveryCodesAndRotateSession({
      userId: input.userId,
      totpEpoch: totp.epoch,
      recoveryCodeHashes: recoveryCodes.map((code) =>
        hashRecoveryCode(input.userId, code, this.platformSecret),
      ),
    });
    return session ? { kind: 'ok', sessionId: session.id, recoveryCodes } : { kind: 'invalid' };
  }
}
