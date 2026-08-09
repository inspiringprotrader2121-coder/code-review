import { createHash } from 'node:crypto';

export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };

export interface DurableRateLimitStore {
  consumeAuthAttempt(
    rateKey: string,
    options: { windowMs: number; max: number },
  ): RateLimitDecision;
  clearAuthAttempts(rateKey: string): void;
  consumeMfaAttempt(userId: string, options: { windowMs: number; max: number }): RateLimitDecision;
  clearMfaAttempts(userId: string): void;
}

export type IdentityRateLimitName =
  | 'registration_ip'
  | 'registration_account'
  | 'login_ip'
  | 'login_account'
  | 'mfa_ip'
  | 'mfa_account'
  | 'security_ip'
  | 'security_account';

export type RateLimitPolicy = Readonly<{
  name: IdentityRateLimitName;
  windowMs: number;
  max: number;
}>;

type Environment = Record<string, string | undefined>;

function boundedEnvNumber(
  environment: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(environment[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

/** All browser-account protections have names, durable keys, and one policy source. */
export function identityRateLimitPolicies(
  environment: Environment,
): Readonly<Record<IdentityRateLimitName, RateLimitPolicy>> {
  const window = (name: string, fallback: number) =>
    boundedEnvNumber(environment, name, fallback, 1_000, 24 * 3600_000);
  const max = (name: string, fallback: number) =>
    boundedEnvNumber(environment, name, fallback, 1, 10_000);
  return {
    registration_ip: {
      name: 'registration_ip',
      windowMs: window('ORVEX_REGISTER_RATE_WINDOW_MS', 60 * 60_000),
      max: max('ORVEX_REGISTER_RATE_IP_MAX', 10),
    },
    registration_account: {
      name: 'registration_account',
      windowMs: window('ORVEX_REGISTER_RATE_WINDOW_MS', 60 * 60_000),
      max: max('ORVEX_REGISTER_RATE_EMAIL_MAX', 3),
    },
    login_ip: {
      name: 'login_ip',
      windowMs: window('ORVEX_LOGIN_RATE_WINDOW_MS', 15 * 60_000),
      max: max('ORVEX_LOGIN_RATE_IP_MAX', 20),
    },
    login_account: {
      name: 'login_account',
      windowMs: window('ORVEX_LOGIN_RATE_WINDOW_MS', 15 * 60_000),
      max: max('ORVEX_LOGIN_RATE_ACCOUNT_MAX', 5),
    },
    mfa_ip: {
      name: 'mfa_ip',
      windowMs: window('ORVEX_MFA_RATE_WINDOW_MS', 10 * 60_000),
      max: max('ORVEX_MFA_RATE_IP_MAX', 20),
    },
    mfa_account: {
      name: 'mfa_account',
      windowMs: window('ORVEX_MFA_RATE_WINDOW_MS', 10 * 60_000),
      max: max('ORVEX_MFA_RATE_MAX', 5),
    },
    security_ip: { name: 'security_ip', windowMs: 10 * 60_000, max: 5 },
    security_account: { name: 'security_account', windowMs: 10 * 60_000, max: 5 },
  };
}

export class DurableIdentityRateLimits {
  readonly policies: Readonly<Record<IdentityRateLimitName, RateLimitPolicy>>;

  constructor(
    private readonly store: DurableRateLimitStore,
    policies: Readonly<Record<IdentityRateLimitName, RateLimitPolicy>>,
  ) {
    this.policies = policies;
  }

  consume(name: Exclude<IdentityRateLimitName, 'mfa_account'>, key: string): RateLimitDecision {
    const policy = this.policies[name];
    return this.store.consumeAuthAttempt(key, policy);
  }

  consumeMfaAccount(userId: string): RateLimitDecision {
    return this.store.consumeMfaAttempt(userId, this.policies.mfa_account);
  }

  clear(key: string): void {
    this.store.clearAuthAttempts(key);
  }

  clearMfaAccount(userId: string): void {
    this.store.clearMfaAttempts(userId);
  }

  accountKey(scope: 'registration' | 'login', email: string): string {
    const value = scope === 'login' ? email || 'empty' : email;
    return `${scope}:account:${createHash('sha256').update(value).digest('hex')}`;
  }

  ipKey(scope: 'registration' | 'login' | 'mfa' | 'security', ip: string, action?: string): string {
    return scope === 'security'
      ? `account-security:ip:${action ?? 'default'}:${ip}`
      : `${scope}:ip:${ip}`;
  }

  securityAccountKey(userId: string, action: string): string {
    return `security:${action}:${userId}`;
  }
}
