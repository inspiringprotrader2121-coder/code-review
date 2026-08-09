import type { User } from '@orvex-review/store';
import {
  IdentityConfigurationError,
  IdentityService,
  type SessionStart,
} from './identity-service.js';
import { DurableIdentityRateLimits } from './rate-limits.js';

export type RegistrationInput = Readonly<{
  email: string;
  password: string;
  confirmPassword: string;
  acceptedTerms: boolean;
  csrfValid: boolean;
  ip: string;
  next: string;
}>;

export type PasswordLoginInput = Readonly<{
  email: string;
  password: string;
  csrfValid: boolean;
  ip: string;
  next: string;
}>;

export type PasswordFlowResult =
  | { kind: 'accepted'; user: User }
  | {
      kind: 'invalid';
      reason:
        | 'csrf'
        | 'terms'
        | 'email'
        | 'password'
        | 'match'
        | 'disposable'
        | 'exists'
        | 'credentials';
    }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

/** Password account admission, rate limiting and login decisions without HTTP concerns. */
export class PasswordSessionFlow {
  constructor(
    private readonly identity: IdentityService,
    private readonly limits: DurableIdentityRateLimits,
  ) {}

  register(input: RegistrationInput): PasswordFlowResult {
    if (!input.csrfValid) return { kind: 'invalid', reason: 'csrf' };
    if (!input.acceptedTerms) return { kind: 'invalid', reason: 'terms' };
    const validation = this.identity.validateRegistration(input);
    if (validation.kind === 'invalid') return validation;
    const ipLimit = this.limits.consume(
      'registration_ip',
      this.limits.ipKey('registration', input.ip),
    );
    const accountLimit = this.limits.consume(
      'registration_account',
      this.limits.accountKey('registration', input.email),
    );
    if (!ipLimit.allowed || !accountLimit.allowed) {
      this.identity.auditEvent({ action: 'password_registration', outcome: 'rate_limited' });
      return {
        kind: 'rate_limited',
        retryAfterSeconds: Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds, 1),
      };
    }
    return this.identity.register(input);
  }

  login(input: PasswordLoginInput): PasswordFlowResult {
    if (!input.csrfValid) return { kind: 'invalid', reason: 'csrf' };
    const ipKey = this.limits.ipKey('login', input.ip);
    const accountKey = this.limits.accountKey('login', input.email);
    const ipLimit = this.limits.consume('login_ip', ipKey);
    const accountLimit = this.limits.consume('login_account', accountKey);
    if (!ipLimit.allowed || !accountLimit.allowed) {
      this.identity.auditEvent({ action: 'password_login', outcome: 'rate_limited' });
      return {
        kind: 'rate_limited',
        retryAfterSeconds: Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds, 1),
      };
    }
    const result = this.identity.authenticatePassword(input.email, input.password);
    if (result.kind === 'invalid') return { kind: 'invalid', reason: 'credentials' };
    this.limits.clear(ipKey);
    this.limits.clear(accountKey);
    return { kind: 'accepted', user: result.user };
  }

  begin(user: User, next: string): SessionStart {
    return this.identity.startSession(user, next);
  }

  configurationError(error: unknown): error is IdentityConfigurationError {
    return error instanceof IdentityConfigurationError;
  }
}
