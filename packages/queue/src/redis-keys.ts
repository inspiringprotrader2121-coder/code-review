import { createHash } from 'node:crypto';

export const DEFAULT_REDIS_QUEUE_NAMESPACE = 'orvex-review';
export const LEASE_TTL_SECONDS = 900;
export const PROCESSING_RECOVERY_GRACE_MS = 30_000;
export const RECOVERY_LEASE_TTL_MS = 90_000;
export const STATE_TTL_SECONDS = 604_800;
export const SEEN_TTL_SECONDS = 86_400;
export const PROCESSING_META_TTL_SECONDS = 3_600;

export interface RedisQueueKeys {
  queue: string;
  seenPrefix: string;
  donePrefix: string;
  inflightPrefix: string;
  pendingPrefix: string;
  pendingCount: string;
  processing: string;
  processingMetaPrefix: string;
  priorityBurst: string;
  /** Active review claim count by tenant, maintained atomically with the PR claim. */
  tenantActive: string;
  /** Claim-token -> tenant mapping so completion, recovery, and expiry can release safely. */
  tenantClaims: string;
  /** Claim-token expiry used to recover tenant slots after a crashed worker. */
  tenantClaimExpiry: string;
  recoveryLease: string;
  resumedPrefix: string;
  deadLetters: string;
  deadLetterDecisions: string;
  statePrefix: string;
}

export function createRedisQueueKeys(namespace: string): RedisQueueKeys {
  const prefix = `${namespace}:`;
  return {
    queue: `${prefix}jobs`,
    seenPrefix: `${prefix}seen:`,
    donePrefix: `${prefix}done:`,
    inflightPrefix: `${prefix}inflight:`,
    pendingPrefix: `${prefix}pending:`,
    pendingCount: `${prefix}pending-count`,
    processing: `${prefix}processing`,
    processingMetaPrefix: `${prefix}processing-meta:`,
    priorityBurst: `${prefix}priority-burst`,
    tenantActive: `${prefix}tenant-active`,
    tenantClaims: `${prefix}tenant-claims`,
    tenantClaimExpiry: `${prefix}tenant-claim-expiry`,
    recoveryLease: `${prefix}recovery-leader`,
    resumedPrefix: `${prefix}resumed:`,
    deadLetters: `${prefix}dead-letters`,
    deadLetterDecisions: `${prefix}dead-letter-decisions`,
    statePrefix: `${prefix}state:`,
  };
}

export function validateRedisQueueNamespace(value: string | undefined): string {
  const namespace = value?.trim() || DEFAULT_REDIS_QUEUE_NAMESPACE;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(namespace)) {
    throw new Error('Redis queue namespace must be 1-128 safe characters');
  }
  return namespace;
}

export function processingMetaKey(prefix: string, entry: string): string {
  return `${prefix}${createHash('sha256').update(entry).digest('hex')}`;
}

export function parseProcessingEntry(entry: string): { token: string; raw: string } {
  const separator = entry.indexOf('\n');
  if (separator < 0) return { token: '', raw: entry };
  return { token: entry.slice(0, separator), raw: entry.slice(separator + 1) };
}

export function claimToken(claim: string): string {
  const separator = claim.indexOf('\n');
  return separator >= 0 ? claim.slice(0, separator) : claim;
}
