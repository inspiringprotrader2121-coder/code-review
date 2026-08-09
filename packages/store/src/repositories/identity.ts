import { createHash, randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../connection.js';
import type { MfaChallenge, Session, User, UserSecurity } from '../types.js';

type MfaFactor = { totpEpoch: number } | { recoveryCodeHash: string };

export interface IdentityRepository {
  upsertUserFromGitHub(input: GitHubUserInput): User;
  setUserNormalizedEmailIfMissing(userId: string, normalizedEmail: string): void;
  getUserByGitHubId(githubId: number): User | null;
  upsertUserFromGoogle(input: GoogleUserInput): User;
  getUserByGoogleId(googleId: string): User | null;
  getUserById(userId: string): User | null;
  upsertPasswordUser(input: PasswordUserInput): User;
  createPasswordUser(input: PasswordUserInput & { normalizedEmail?: string }): User | null;
  setUserEmailVerified(userId: string, verifiedAt?: string): boolean;
  getUserByEmail(email: string): User | null;
  getUserByNormalizedEmail(normalizedEmail: string): User | null;
  getPasswordHash(userId: string): string | null;
  setUserSuperAdmin(userId: string, enabled: boolean): boolean;
  getUserSecurity(userId: string): UserSecurity;
  setPendingTotpSecret(userId: string, encryptedSecret: string): boolean;
  enableTotp(userId: string, recoveryCodeHashes: string[]): boolean;
  completeTotpEnrollment(input: TotpEnrollmentInput): Session | null;
  disableTotpAndRotateSession(input: TotpDisableInput): Session | null;
  regenerateRecoveryCodesAndRotateSession(input: RecoveryRegenerationInput): Session | null;
  disableTotp(userId: string): void;
  consumeRecoveryCode(userId: string, codeHash: string): boolean;
  acceptTotpEpoch(userId: string, epoch: number): boolean;
  consumeAuthAttempt(rateKey: string, opts: AuthRateLimit, now?: number): AuthRateLimitResult;
  clearAuthAttempts(rateKey: string): void;
  consumeMfaAttempt(userId: string, opts: AuthRateLimit, now?: number): AuthRateLimitResult;
  clearMfaAttempts(userId: string): void;
  createMfaChallenge(userId: string, next: string, ttlMs?: number): MfaChallenge;
  getMfaChallenge(id: string): MfaChallenge | null;
  consumeMfaChallenge(id: string): MfaChallenge | null;
  completeMfaChallenge(
    challengeId: string,
    factor: MfaFactor,
    sessionTtlMs?: number,
  ): { challenge: MfaChallenge; session: Session } | null;
  deleteMfaChallenge(id: string): void;
  deleteMfaChallengesForUser(userId: string): void;
  hasPasswordUsers(): boolean;
  createSession(userId: string, ttlMs?: number): Session;
  getSessionUser(sessionId: string): User | null;
  deleteSession(sessionId: string): void;
  deleteSessionsForUser(userId: string): number;
}

export interface GitHubUserInput {
  githubId: number;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
  normalizedEmail?: string;
}
export interface GoogleUserInput {
  googleId: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  normalizedEmail?: string;
}
export interface PasswordUserInput {
  email: string;
  passwordHash: string;
  name?: string;
  login?: string;
}
export interface TotpEnrollmentInput {
  userId: string;
  expectedEncryptedSecret: string;
  totpEpoch: number;
  recoveryCodeHashes: string[];
  sessionTtlMs?: number;
}
export interface TotpDisableInput {
  userId: string;
  factor: MfaFactor;
  sessionTtlMs?: number;
}
export interface RecoveryRegenerationInput {
  userId: string;
  totpEpoch: number;
  recoveryCodeHashes: string[];
  sessionTtlMs?: number;
}
export interface AuthRateLimit {
  windowMs: number;
  max: number;
}
export interface AuthRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class SqliteIdentityRepository implements IdentityRepository {
  constructor(private readonly db: SqliteConnection) {}

  upsertUserFromGitHub(input: GitHubUserInput): User {
    const email = input.email?.trim().toLowerCase();
    const now = new Date().toISOString();
    const existingGithub = this.getUserByGitHubId(input.githubId);
    if (existingGithub) {
      const emailOwner = email ? this.getUserByEmail(email) : null;
      this.db
        .prepare(
          `UPDATE users SET login = ?, name = ?, avatar_url = ?, email = CASE WHEN ? IS NULL OR ? IS NOT NULL THEN email ELSE ? END WHERE id = ?`,
        )
        .run(
          input.login,
          input.name ?? null,
          input.avatarUrl ?? null,
          email ?? null,
          emailOwner && emailOwner.id !== existingGithub.id ? emailOwner.id : null,
          email ?? null,
          existingGithub.id,
        );
      return this.getUserById(existingGithub.id)!;
    }
    const existingEmail = email ? this.getUserByEmail(email) : null;
    if (existingEmail) {
      if (existingEmail.githubId > 0)
        throw new Error('This email is already linked to a different GitHub account');
      const passwordState = this.db
        .prepare(`SELECT password_hash, email_verified_at FROM users WHERE id = ?`)
        .get(existingEmail.id) as PasswordState | undefined;
      if (passwordState?.password_hash && !passwordState.email_verified_at)
        throw new Error(
          'This email belongs to an unverified password account; sign in there before linking GitHub',
        );
      this.db
        .prepare(
          `UPDATE users SET github_id = ?, login = ?, name = ?, avatar_url = ?, email = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`,
        )
        .run(
          input.githubId,
          input.login,
          input.name ?? null,
          input.avatarUrl ?? null,
          email,
          now,
          existingEmail.id,
        );
      return this.getUserById(existingEmail.id)!;
    }
    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, avatar_url, email, email_verified_at, normalized_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.githubId,
        input.login,
        input.name ?? null,
        input.avatarUrl ?? null,
        email ?? null,
        email ? now : null,
        input.normalizedEmail ?? email ?? null,
        now,
      );
    return this.getUserByGitHubId(input.githubId)!;
  }

  setUserNormalizedEmailIfMissing(userId: string, normalizedEmail: string): void {
    this.db
      .prepare(`UPDATE users SET normalized_email = ? WHERE id = ? AND normalized_email IS NULL`)
      .run(normalizedEmail.trim().toLowerCase(), userId);
  }
  getUserByGitHubId(githubId: number): User | null {
    return this.mapUserRow(
      this.db.prepare(`SELECT * FROM users WHERE github_id = ?`).get(githubId) as
        | UserRow
        | undefined,
    );
  }

  upsertUserFromGoogle(input: GoogleUserInput): User {
    const email = input.email.trim().toLowerCase();
    const now = new Date().toISOString();
    const existingGoogle = this.getUserByGoogleId(input.googleId);
    if (existingGoogle) {
      this.db
        .prepare(`UPDATE users SET name = ?, avatar_url = ?, email = ? WHERE id = ?`)
        .run(input.name ?? null, input.avatarUrl ?? null, email, existingGoogle.id);
      return this.getUserById(existingGoogle.id)!;
    }
    const existingEmail = this.getUserByEmail(email);
    if (existingEmail) {
      const linked = this.db
        .prepare(`SELECT google_id FROM users WHERE id = ?`)
        .get(existingEmail.id) as { google_id: string | null } | undefined;
      if (linked?.google_id)
        throw new Error('This email is already linked to a different Google account');
      const passwordState = this.db
        .prepare(`SELECT password_hash, email_verified_at FROM users WHERE id = ?`)
        .get(existingEmail.id) as PasswordState | undefined;
      if (passwordState?.password_hash && !passwordState.email_verified_at)
        throw new Error(
          'This email belongs to an unverified password account; sign in there before linking Google',
        );
      this.db
        .prepare(
          `UPDATE users SET google_id = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url), email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`,
        )
        .run(input.googleId, input.name ?? null, input.avatarUrl ?? null, now, existingEmail.id);
      return this.getUserById(existingEmail.id)!;
    }
    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, avatar_url, email, email_verified_at, normalized_email, google_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        syntheticGithubId(`google:${input.googleId}`),
        email,
        input.name ?? null,
        input.avatarUrl ?? null,
        email,
        now,
        input.normalizedEmail ?? email,
        input.googleId,
        now,
      );
    return this.getUserByGoogleId(input.googleId)!;
  }

  getUserByGoogleId(googleId: string): User | null {
    return this.mapUserRow(
      this.db.prepare(`SELECT * FROM users WHERE google_id = ?`).get(googleId) as
        | UserRow
        | undefined,
    );
  }
  getUserById(userId: string): User | null {
    return this.mapUserRow(
      this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | undefined,
    );
  }

  upsertPasswordUser(input: PasswordUserInput): User {
    const email = input.email.toLowerCase().trim();
    const existing = this.getUserByEmail(email);
    if (existing) {
      this.db
        .prepare(`UPDATE users SET password_hash = ?, name = COALESCE(?, name) WHERE id = ?`)
        .run(input.passwordHash, input.name ?? null, existing.id);
      return this.getUserById(existing.id)!;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO users (id, github_id, login, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        syntheticGithubId(email),
        input.login ?? email,
        input.name ?? null,
        email,
        input.passwordHash,
        now,
      );
    return this.getUserByEmail(email)!;
  }

  createPasswordUser(input: PasswordUserInput & { normalizedEmail?: string }): User | null {
    const email = input.email.toLowerCase().trim();
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO users (id, github_id, login, name, email, normalized_email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        syntheticGithubId(email),
        input.login ?? email,
        input.name ?? null,
        email,
        input.normalizedEmail ?? email,
        input.passwordHash,
        now,
      );
    return result.changes === 1 ? this.getUserByEmail(email) : null;
  }

  setUserEmailVerified(userId: string, verifiedAt = new Date().toISOString()): boolean {
    return (
      this.db
        .prepare(
          `UPDATE users SET email_verified_at = ? WHERE id = ? AND password_hash IS NOT NULL`,
        )
        .run(verifiedAt, userId).changes > 0
    );
  }
  getUserByEmail(email: string): User | null {
    return this.mapUserRow(
      this.db.prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`).get(email.trim()) as
        | UserRow
        | undefined,
    );
  }
  getUserByNormalizedEmail(email: string): User | null {
    return this.mapUserRow(
      this.db
        .prepare(`SELECT * FROM users WHERE normalized_email = ? LIMIT 1`)
        .get(email.trim().toLowerCase()) as UserRow | undefined,
    );
  }
  getPasswordHash(userId: string): string | null {
    return (
      (
        this.db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as
          | PasswordState
          | undefined
      )?.password_hash ?? null
    );
  }
  setUserSuperAdmin(userId: string, enabled: boolean): boolean {
    return (
      this.db
        .prepare(`UPDATE users SET is_superadmin = ? WHERE id = ?`)
        .run(enabled ? 1 : 0, userId).changes > 0
    );
  }

  getUserSecurity(userId: string): UserSecurity {
    const row = this.db
      .prepare(
        `SELECT user_id, totp_enabled, totp_secret_encrypted, last_totp_epoch, recovery_code_hashes_json, updated_at FROM user_security WHERE user_id = ?`,
      )
      .get(userId) as SecurityRow | undefined;
    if (!row)
      return {
        userId,
        totpEnabled: false,
        recoveryCodeHashes: [],
        updatedAt: new Date(0).toISOString(),
      };
    return {
      userId: row.user_id,
      totpEnabled: Boolean(row.totp_enabled),
      totpSecretEncrypted: row.totp_secret_encrypted ?? undefined,
      lastTotpEpoch: row.last_totp_epoch ?? undefined,
      recoveryCodeHashes: parseStringArray(row.recovery_code_hashes_json),
      updatedAt: row.updated_at,
    };
  }
  setPendingTotpSecret(userId: string, encryptedSecret: string): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO user_security (user_id, totp_enabled, totp_secret_encrypted, recovery_code_hashes_json, updated_at) VALUES (?, 0, ?, '[]', ?) ON CONFLICT(user_id) DO UPDATE SET totp_enabled = 0, totp_secret_encrypted = excluded.totp_secret_encrypted, last_totp_epoch = NULL, recovery_code_hashes_json = '[]', updated_at = excluded.updated_at WHERE user_security.totp_enabled = 0`,
        )
        .run(userId, encryptedSecret, new Date().toISOString()).changes > 0
    );
  }
  enableTotp(userId: string, hashes: string[]): boolean {
    return (
      this.db
        .prepare(
          `UPDATE user_security SET totp_enabled = 1, recovery_code_hashes_json = ?, updated_at = ? WHERE user_id = ? AND totp_enabled = 0 AND totp_secret_encrypted IS NOT NULL`,
        )
        .run(JSON.stringify(hashes), new Date().toISOString(), userId).changes > 0
    );
  }

  completeTotpEnrollment(input: TotpEnrollmentInput): Session | null {
    if (!validTotpEpoch(input.totpEpoch)) return null;
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE user_security SET totp_enabled = 1, last_totp_epoch = ?, recovery_code_hashes_json = ?, updated_at = ? WHERE user_id = ? AND totp_enabled = 0 AND totp_secret_encrypted = ?`,
        )
        .run(
          input.totpEpoch,
          JSON.stringify(input.recoveryCodeHashes),
          new Date().toISOString(),
          input.userId,
          input.expectedEncryptedSecret,
        );
      if (changed.changes !== 1) return null;
      this.clearMfaStateForUser(input.userId);
      return this.replaceUserSessions(input.userId, input.sessionTtlMs);
    })();
  }
  disableTotpAndRotateSession(input: TotpDisableInput): Session | null {
    return this.db.transaction(() => {
      const row = this.securityFactorRow(input.userId);
      if (!row || !this.securityFactorIsFresh(row, input.factor)) return null;
      if (
        this.db.prepare(`DELETE FROM user_security WHERE user_id = ?`).run(input.userId).changes !==
        1
      )
        return null;
      this.clearMfaStateForUser(input.userId);
      return this.replaceUserSessions(input.userId, input.sessionTtlMs);
    })();
  }
  regenerateRecoveryCodesAndRotateSession(input: RecoveryRegenerationInput): Session | null {
    if (!validTotpEpoch(input.totpEpoch)) return null;
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE user_security SET last_totp_epoch = ?, recovery_code_hashes_json = ?, updated_at = ? WHERE user_id = ? AND totp_enabled = 1 AND (last_totp_epoch IS NULL OR last_totp_epoch < ?)`,
        )
        .run(
          input.totpEpoch,
          JSON.stringify(input.recoveryCodeHashes),
          new Date().toISOString(),
          input.userId,
          input.totpEpoch,
        );
      if (changed.changes !== 1) return null;
      this.clearMfaStateForUser(input.userId);
      return this.replaceUserSessions(input.userId, input.sessionTtlMs);
    })();
  }
  disableTotp(userId: string): void {
    this.db.prepare(`DELETE FROM user_security WHERE user_id = ?`).run(userId);
  }
  consumeRecoveryCode(userId: string, codeHash: string): boolean {
    const security = this.getUserSecurity(userId);
    const index = security.recoveryCodeHashes.indexOf(codeHash);
    if (!security.totpEnabled || index < 0) return false;
    const remaining = security.recoveryCodeHashes.filter((_, position) => position !== index);
    return (
      this.db
        .prepare(
          `UPDATE user_security SET recovery_code_hashes_json = ?, updated_at = ? WHERE user_id = ? AND recovery_code_hashes_json = ?`,
        )
        .run(
          JSON.stringify(remaining),
          new Date().toISOString(),
          userId,
          JSON.stringify(security.recoveryCodeHashes),
        ).changes > 0
    );
  }
  acceptTotpEpoch(userId: string, epoch: number): boolean {
    if (!validTotpEpoch(epoch)) return false;
    return (
      this.db
        .prepare(
          `UPDATE user_security SET last_totp_epoch = ?, updated_at = ? WHERE user_id = ? AND totp_enabled = 1 AND (last_totp_epoch IS NULL OR last_totp_epoch < ?)`,
        )
        .run(epoch, new Date().toISOString(), userId, epoch).changes > 0
    );
  }

  consumeAuthAttempt(rateKey: string, opts: AuthRateLimit, now = Date.now()): AuthRateLimitResult {
    if (
      !rateKey ||
      !Number.isFinite(opts.windowMs) ||
      opts.windowMs <= 0 ||
      !Number.isInteger(opts.max) ||
      opts.max <= 0
    )
      return { allowed: false, retryAfterSeconds: 1 };
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(`SELECT attempt_count, reset_at FROM auth_rate_limits WHERE rate_key = ?`)
          .get(rateKey) as RateLimitRow | undefined;
        const resetAt = row ? new Date(row.reset_at).getTime() : 0;
        if (!row || !Number.isFinite(resetAt) || resetAt <= now) {
          this.db
            .prepare(
              `INSERT INTO auth_rate_limits (rate_key, attempt_count, reset_at) VALUES (?, 1, ?) ON CONFLICT(rate_key) DO UPDATE SET attempt_count = 1, reset_at = excluded.reset_at`,
            )
            .run(rateKey, new Date(now + opts.windowMs).toISOString());
          return { allowed: true, retryAfterSeconds: 0 };
        }
        if (row.attempt_count >= opts.max)
          return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
          };
        this.db
          .prepare(
            `UPDATE auth_rate_limits SET attempt_count = attempt_count + 1 WHERE rate_key = ?`,
          )
          .run(rateKey);
        return { allowed: true, retryAfterSeconds: 0 };
      })
      .immediate();
  }
  clearAuthAttempts(rateKey: string): void {
    this.db.prepare(`DELETE FROM auth_rate_limits WHERE rate_key = ?`).run(rateKey);
  }
  consumeMfaAttempt(userId: string, opts: AuthRateLimit, now = Date.now()): AuthRateLimitResult {
    return this.consumeAuthAttempt(`mfa:${userId}`, opts, now);
  }
  clearMfaAttempts(userId: string): void {
    this.clearAuthAttempts(`mfa:${userId}`);
  }

  createMfaChallenge(userId: string, next: string, ttlMs = 5 * 60_000): MfaChallenge {
    const createdAt = new Date();
    const challenge = {
      id: randomUUID(),
      userId,
      next,
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      createdAt: createdAt.toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO mfa_challenges (id, user_id, next, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        challenge.id,
        challenge.userId,
        challenge.next,
        challenge.expiresAt,
        challenge.createdAt,
      );
    return challenge;
  }
  getMfaChallenge(id: string): MfaChallenge | null {
    const row = this.db
      .prepare(`SELECT id, user_id, next, expires_at, created_at FROM mfa_challenges WHERE id = ?`)
      .get(id) as ChallengeRow | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.deleteMfaChallenge(id);
      return null;
    }
    return mapChallenge(row);
  }
  consumeMfaChallenge(id: string): MfaChallenge | null {
    return this.db.transaction(() => {
      const challenge = this.getMfaChallenge(id);
      return challenge &&
        this.db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`).run(id).changes === 1
        ? challenge
        : null;
    })();
  }
  completeMfaChallenge(
    challengeId: string,
    factor: MfaFactor,
    sessionTtlMs = 30 * 24 * 3_600_000,
  ): { challenge: MfaChallenge; session: Session } | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT c.id, c.user_id, c.next, c.expires_at, c.created_at, s.totp_enabled, s.last_totp_epoch, s.recovery_code_hashes_json FROM mfa_challenges c JOIN user_security s ON s.user_id = c.user_id WHERE c.id = ?`,
        )
        .get(challengeId) as ChallengeFactorRow | undefined;
      if (!row || !row.totp_enabled) return null;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        this.db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`).run(challengeId);
        return null;
      }
      if (!this.securityFactorIsFresh(row, factor)) return null;
      if (this.db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`).run(challengeId).changes !== 1)
        return null;
      if ('totpEpoch' in factor) {
        if (
          this.db
            .prepare(
              `UPDATE user_security SET last_totp_epoch = ?, updated_at = ? WHERE user_id = ? AND totp_enabled = 1 AND (last_totp_epoch IS NULL OR last_totp_epoch < ?)`,
            )
            .run(factor.totpEpoch, new Date().toISOString(), row.user_id, factor.totpEpoch)
            .changes !== 1
        )
          throw new Error('MFA replay state changed during challenge completion');
      } else {
        const remaining = parseStringArray(row.recovery_code_hashes_json).filter(
          (hash) => hash !== factor.recoveryCodeHash,
        );
        if (
          this.db
            .prepare(
              `UPDATE user_security SET recovery_code_hashes_json = ?, updated_at = ? WHERE user_id = ? AND totp_enabled = 1 AND recovery_code_hashes_json = ?`,
            )
            .run(
              JSON.stringify(remaining),
              new Date().toISOString(),
              row.user_id,
              row.recovery_code_hashes_json,
            ).changes !== 1
        )
          throw new Error('MFA recovery state changed during challenge completion');
      }
      this.clearMfaAttempts(row.user_id);
      return {
        challenge: mapChallenge(row),
        session: this.replaceUserSessions(row.user_id, sessionTtlMs),
      };
    })();
  }
  deleteMfaChallenge(id: string): void {
    this.db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`).run(id);
  }
  deleteMfaChallengesForUser(userId: string): void {
    this.db.prepare(`DELETE FROM mfa_challenges WHERE user_id = ?`).run(userId);
  }
  hasPasswordUsers(): boolean {
    return (
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL`)
          .get() as { n: number }
      ).n > 0
    );
  }
  createSession(userId: string, ttlMs = 30 * 24 * 3_600_000): Session {
    const now = new Date();
    const createdAt = now.toISOString();
    const session = {
      id: randomUUID(),
      userId,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      createdAt,
    };
    this.db
      .prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .run(session.id, userId, session.expiresAt, createdAt);
    return session;
  }
  getSessionUser(sessionId: string): User | null {
    const row = this.db
      .prepare(`SELECT user_id, expires_at FROM sessions WHERE id = ?`)
      .get(sessionId) as { user_id: string; expires_at: string } | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.deleteSession(sessionId);
      return null;
    }
    return this.getUserById(row.user_id);
  }
  deleteSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }
  deleteSessionsForUser(userId: string): number {
    return this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId).changes;
  }

  private mapUserRow(row: UserRow | undefined): User | null {
    return row
      ? {
          id: row.id,
          githubId: row.github_id,
          googleId: row.google_id ?? undefined,
          login: row.login,
          name: row.name ?? undefined,
          avatarUrl: row.avatar_url ?? undefined,
          email: row.email ?? undefined,
          isSuperAdmin: Boolean(row.is_superadmin),
          createdAt: row.created_at,
        }
      : null;
  }
  private securityFactorRow(userId: string): SecurityFactorRow | null {
    return (
      (this.db
        .prepare(
          `SELECT totp_enabled, last_totp_epoch, recovery_code_hashes_json FROM user_security WHERE user_id = ?`,
        )
        .get(userId) as SecurityFactorRow | undefined) ?? null
    );
  }
  private securityFactorIsFresh(row: SecurityFactorRow, factor: MfaFactor): boolean {
    return (
      Boolean(row.totp_enabled) &&
      ('totpEpoch' in factor
        ? validTotpEpoch(factor.totpEpoch) &&
          (row.last_totp_epoch === null || row.last_totp_epoch < factor.totpEpoch)
        : parseStringArray(row.recovery_code_hashes_json).includes(factor.recoveryCodeHash))
    );
  }
  private clearMfaStateForUser(userId: string): void {
    this.db.prepare(`DELETE FROM mfa_challenges WHERE user_id = ?`).run(userId);
    this.db
      .prepare(`DELETE FROM auth_rate_limits WHERE rate_key IN (?, ?, ?, ?)`)
      .run(
        `mfa:${userId}`,
        `security:enable:${userId}`,
        `security:disable:${userId}`,
        `security:recovery:${userId}`,
      );
  }
  private replaceUserSessions(userId: string, ttlMs = 30 * 24 * 3_600_000): Session {
    this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
    return this.createSession(userId, ttlMs);
  }
}

interface UserRow {
  id: string;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
  google_id?: string | null;
  is_superadmin: number;
  created_at: string;
}
interface PasswordState {
  password_hash: string | null;
  email_verified_at?: string | null;
}
interface SecurityRow {
  user_id: string;
  totp_enabled: number;
  totp_secret_encrypted: string | null;
  last_totp_epoch: number | null;
  recovery_code_hashes_json: string;
  updated_at: string;
}
interface SecurityFactorRow {
  totp_enabled: number;
  last_totp_epoch: number | null;
  recovery_code_hashes_json: string;
}
interface ChallengeRow {
  id: string;
  user_id: string;
  next: string;
  expires_at: string;
  created_at: string;
}
interface ChallengeFactorRow extends ChallengeRow, SecurityFactorRow {}
interface RateLimitRow {
  attempt_count: number;
  reset_at: string;
}
function mapChallenge(row: ChallengeRow): MfaChallenge {
  return {
    id: row.id,
    userId: row.user_id,
    next: row.next,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
function validTotpEpoch(epoch: number): boolean {
  return Number.isSafeInteger(epoch) && epoch >= 0;
}
function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}
function syntheticGithubId(seed: string): number {
  const value = createHash('sha256').update(seed).digest().readUIntBE(0, 6);
  return -(value || 1);
}
