import type { IdentityRepository } from '@orvex-review/store';
import { IdentityService } from './identity-service.js';
import { DurableIdentityRateLimits } from './rate-limits.js';

export type MfaChallengeStore = Pick<IdentityRepository, 'getMfaChallenge'>;

export type MfaFlowResult =
  | { kind: 'missing' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'invalid' }
  | { kind: 'accepted'; sessionId: string; destination: string };

/** MFA challenge ownership, durable throttling and replay-safe completion. */
export class MfaChallengeFlow {
  constructor(
    private readonly db: MfaChallengeStore,
    private readonly identity: IdentityService,
    private readonly limits: DurableIdentityRateLimits,
  ) {}

  exists(challengeId: string | undefined): boolean {
    return Boolean(challengeId && this.db.getMfaChallenge(challengeId));
  }

  async complete(
    input: Readonly<{ challengeId: string | undefined; code: string; ip: string }>,
  ): Promise<MfaFlowResult> {
    const challenge = input.challengeId ? this.db.getMfaChallenge(input.challengeId) : null;
    if (!challenge) return { kind: 'missing' };
    const ipKey = this.limits.ipKey('mfa', input.ip);
    const ipLimit = this.limits.consume('mfa_ip', ipKey);
    const accountLimit = this.limits.consumeMfaAccount(challenge.userId);
    if (!ipLimit.allowed || !accountLimit.allowed) {
      this.identity.auditEvent({
        action: 'mfa_login',
        outcome: 'rate_limited',
        userId: challenge.userId,
      });
      return {
        kind: 'rate_limited',
        retryAfterSeconds: Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds, 1),
      };
    }
    const completed = await this.identity.verifyMfaLogin(challenge.id, input.code);
    if (completed.kind === 'invalid') return completed;
    this.limits.clear(ipKey);
    return { kind: 'accepted', sessionId: completed.sessionId, destination: completed.destination };
  }
}
