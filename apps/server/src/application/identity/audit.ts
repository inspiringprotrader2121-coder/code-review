/**
 * Identity audit events deliberately contain only stable identifiers and outcome
 * codes. Passwords, OAuth codes/tokens, CSRF values, recovery codes, IPs and
 * provider responses must never be attached to these events.
 */
export type IdentityAuditEvent = {
  action:
    | 'password_login'
    | 'password_registration'
    | 'oauth_login'
    | 'oauth_link'
    | 'oauth_reauth'
    | 'mfa_challenge'
    | 'mfa_login'
    | 'mfa_enrollment'
    | 'mfa_disabled'
    | 'recovery_codes_regenerated'
    | 'session_revoked';
  outcome: 'accepted' | 'rejected' | 'rate_limited' | 'failed';
  provider?: 'github' | 'google';
  userId?: string;
  reason?:
    | 'invalid_credentials'
    | 'invalid_csrf'
    | 'invalid_factor'
    | 'invalid_state'
    | 'missing_configuration'
    | 'missing_session'
    | 'mismatched_identity'
    | 'not_configured';
};

export interface IdentityAuditSink {
  record(event: IdentityAuditEvent): void;
}

export const noOpIdentityAuditSink: IdentityAuditSink = {
  record() {},
};

/** A deliberately small, redacted operational adapter for production logs. */
export const consoleIdentityAuditSink: IdentityAuditSink = {
  record(event) {
    console.info('[identity-audit]', JSON.stringify(event));
  },
};
