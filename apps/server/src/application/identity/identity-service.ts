import type { IdentityRepository, TenancyRepository, User } from '@orvex-review/store';
import {
  decryptTotpSecret,
  hashPassword,
  isDisposableEmail,
  normalizeEmail,
  recoveryCodeMatches,
  verifyPassword,
  verifyTotpCodeWithEpoch,
} from '@orvex-review/tenants';
import type { IdentityAuditSink } from './audit.js';
import { noOpIdentityAuditSink, type IdentityAuditEvent } from './audit.js';

const DUMMY_PASSWORD_HASH = hashPassword('orvex-login-timing-guard');

export type PasswordRegistration = {
  email: string;
  password: string;
  confirmPassword: string;
};

export type PasswordRegistrationResult =
  | { kind: 'accepted'; user: User }
  | { kind: 'invalid'; reason: 'email' | 'password' | 'match' | 'disposable' | 'exists' };

export type PasswordLoginResult = { kind: 'accepted'; user: User } | { kind: 'invalid' };

export type PasswordRegistrationValidation =
  | { kind: 'accepted' }
  | { kind: 'invalid'; reason: 'email' | 'password' | 'match' };

export type SessionStart =
  | { kind: 'session'; sessionId: string; destination: string }
  | { kind: 'mfa'; challengeId: string };

export type MfaLoginResult =
  | { kind: 'accepted'; sessionId: string; destination: string; userId: string }
  | { kind: 'invalid' };

/** Identity needs account/session records plus a user's workspace list only. */
export type IdentityStore = Pick<
  IdentityRepository,
  | 'completeMfaChallenge'
  | 'createMfaChallenge'
  | 'createPasswordUser'
  | 'createSession'
  | 'deleteSessionsForUser'
  | 'getMfaChallenge'
  | 'getPasswordHash'
  | 'getUserByEmail'
  | 'getUserById'
  | 'getUserByNormalizedEmail'
  | 'getUserSecurity'
  | 'hasPasswordUsers'
> &
  Pick<TenancyRepository, 'getWorkspacesForUser'>;

/**
 * Application-level identity rules. The route owns HTTP/cookies, while this
 * service owns user, session, MFA and anti-enumeration decisions.
 */
export class IdentityService {
  constructor(
    private readonly db: IdentityStore,
    private readonly platformSecret: string,
    private readonly requireLogin: boolean,
    private readonly audit: IdentityAuditSink = noOpIdentityAuditSink,
  ) {}

  passwordAuthEnabled(): boolean {
    return this.requireLogin || this.db.hasPasswordUsers();
  }

  register(input: PasswordRegistration): PasswordRegistrationResult {
    const email = input.email.trim().toLowerCase();
    const validation = this.validateRegistration(input);
    if (validation.kind === 'invalid') return validation;
    if (isDisposableEmail(email)) return { kind: 'invalid', reason: 'disposable' };
    const normalizedEmail = normalizeEmail(email);
    if (this.db.getUserByEmail(email) || this.db.getUserByNormalizedEmail(normalizedEmail)) {
      return { kind: 'invalid', reason: 'exists' };
    }
    const user = this.db.createPasswordUser({
      email,
      passwordHash: hashPassword(input.password),
      normalizedEmail,
    });
    if (!user) return { kind: 'invalid', reason: 'exists' };
    this.audit.record({ action: 'password_registration', outcome: 'accepted', userId: user.id });
    return { kind: 'accepted', user };
  }

  validateRegistration(input: PasswordRegistration): PasswordRegistrationValidation {
    const email = input.email.trim().toLowerCase();
    if (!isValidEmail(email)) return { kind: 'invalid', reason: 'email' };
    if (input.password.length < 12 || input.password.length > 1_024)
      return { kind: 'invalid', reason: 'password' };
    if (input.password !== input.confirmPassword) return { kind: 'invalid', reason: 'match' };
    return { kind: 'accepted' };
  }

  authenticatePassword(email: string, password: string): PasswordLoginResult {
    const normalized = email.trim().toLowerCase();
    const user = normalized ? this.db.getUserByEmail(normalized) : null;
    const storedHash = user ? this.db.getPasswordHash(user.id) : null;
    // Preserve equal scrypt work for valid and invalid account names.
    const valid = verifyPassword(password, storedHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !storedHash || !valid) {
      this.audit.record({
        action: 'password_login',
        outcome: 'rejected',
        reason: 'invalid_credentials',
      });
      return { kind: 'invalid' };
    }
    this.audit.record({ action: 'password_login', outcome: 'accepted', userId: user.id });
    return { kind: 'accepted', user };
  }

  startSession(user: User, next: string): SessionStart {
    const security = this.db.getUserSecurity(user.id);
    if (security.totpEnabled) {
      if (!security.totpSecretEncrypted)
        throw new IdentityConfigurationError('two-factor authentication is misconfigured');
      const challenge = this.db.createMfaChallenge(user.id, next);
      this.audit.record({ action: 'mfa_challenge', outcome: 'accepted', userId: user.id });
      return { kind: 'mfa', challengeId: challenge.id };
    }
    this.db.deleteSessionsForUser(user.id);
    const session = this.db.createSession(user.id);
    return {
      kind: 'session',
      sessionId: session.id,
      destination: this.postAuthDestination(user, next),
    };
  }

  async verifyMfaLogin(challengeId: string, code: string): Promise<MfaLoginResult> {
    const challenge = this.db.getMfaChallenge(challengeId);
    if (!challenge) return { kind: 'invalid' };
    const security = this.db.getUserSecurity(challenge.userId);
    const secret = security.totpSecretEncrypted
      ? decryptTotpSecret(security.totpSecretEncrypted, this.platformSecret)
      : null;
    const totp = secret ? await verifyTotpCodeWithEpoch(secret, code) : { valid: false as const };
    const recoveryCodeHash = security.recoveryCodeHashes.find((hash) =>
      recoveryCodeMatches(hash, challenge.userId, code, this.platformSecret),
    );
    const factor =
      totp.valid && totp.epoch !== undefined
        ? { totpEpoch: totp.epoch }
        : recoveryCodeHash
          ? { recoveryCodeHash }
          : null;
    if (!security.totpEnabled || !factor) {
      this.audit.record({
        action: 'mfa_login',
        outcome: 'rejected',
        userId: challenge.userId,
        reason: 'invalid_factor',
      });
      return { kind: 'invalid' };
    }
    const completed = this.db.completeMfaChallenge(challenge.id, factor);
    if (!completed) {
      this.audit.record({
        action: 'mfa_login',
        outcome: 'rejected',
        userId: challenge.userId,
        reason: 'invalid_factor',
      });
      return { kind: 'invalid' };
    }
    const user = this.db.getUserById(completed.challenge.userId);
    const destination = user
      ? this.postAuthDestination(user, completed.challenge.next)
      : safeNext(completed.challenge.next);
    this.audit.record({
      action: 'mfa_login',
      outcome: 'accepted',
      userId: completed.challenge.userId,
    });
    return {
      kind: 'accepted',
      sessionId: completed.session.id,
      destination,
      userId: completed.challenge.userId,
    };
  }

  postAuthDestination(user: User, next: string | undefined): string {
    const destination = safeNext(next);
    return destination === '/connect' && this.db.getWorkspacesForUser(user.id).length > 0
      ? '/dashboard'
      : destination;
  }

  auditEvent(event: IdentityAuditEvent): void {
    this.audit.record(event);
  }
}

export class IdentityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigurationError';
  }
}

export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return '/dashboard';
  return next;
}

function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
