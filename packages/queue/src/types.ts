export type JobId = string;

export type JobKind = 'review' | 'fix' | 'explain' | 'ask' | 'resolve' | 'scan';

/** Which findings a fix job targets. */
export type FixScope =
  | 'ready' // findings that already carry a machine-applicable fix
  | 'all' // every open finding; missing fixes are generated with the LLM
  | 'one'; // a single finding (checkbox / thread reply), by fingerprint

export interface FixRequest {
  scope: FixScope;
  /** target finding for scope 'one' */
  fingerprint?: string;
  /** free-form user instruction ("@orvex make this use a Set") */
  instruction?: string;
  /** review-comment id the command came from (thread replies land here) */
  replyToCommentId?: number;
  /** true when replyToCommentId is an inline review comment, not an issue comment */
  isReviewComment?: boolean;
  /** login of the human who asked */
  requestedBy?: string;
}

export interface ReviewJobPayload {
  /** defaults to 'review' for backward compatibility */
  kind?: JobKind;
  installationId: number;
  tenantId: string;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  action: 'opened' | 'synchronize' | 'reopened' | 'manual' | 'command';
  fix?: FixRequest;
  enqueuedAt: string;
}

export interface EnqueueResult {
  accepted: boolean;
  jobId: JobId;
  reason?: 'duplicate' | 'coalesced' | 'enqueued';
}

export interface ReviewQueue {
  enqueue(job: ReviewJobPayload): Promise<EnqueueResult>;
  dequeue(): Promise<ReviewJobPayload | null>;
  markCompleted(job: ReviewJobPayload): Promise<void>;
  markFailed(job: ReviewJobPayload, error: string): Promise<void>;
  releaseLockAndDrain(prKey: string): Promise<ReviewJobPayload | null>;
  /** Startup cleanup: clear stale in-flight locks + requeue pending. Returns count. */
  recoverOrphans(): Promise<number>;
  /** Liveness probe for /health — true if the backing store is reachable. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function jobIdempotencyKey(job: ReviewJobPayload): string {
  const kind = job.kind ?? 'review';
  const base = `${job.installationId}/${job.owner}/${job.repo}#${job.pr}@${job.headSha}`;
  // Explicit human triggers (`@orvex review` command, CLI manual) must ALWAYS
  // run — never dedup them against an earlier automatic review of the same sha.
  // Only automatic webhook events (opened/synchronize/reopened) dedup.
  if (job.action === 'command' || job.action === 'manual') {
    return `${base}:${kind}:${job.enqueuedAt}`;
  }
  if (kind === 'review') return base;
  const fix = job.fix;
  // include instruction so two different free-form `@orvex <x>` replies on the
  // same thread aren't collapsed into one and silently deduped.
  const instr = fix?.instruction ? `:${hashShort(fix.instruction)}` : '';
  return `${base}:${kind}:${fix?.scope ?? 'ready'}:${fix?.fingerprint ?? ''}:${fix?.replyToCommentId ?? ''}${instr}`;
}

function hashShort(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function prKey(job: Pick<ReviewJobPayload, 'installationId' | 'owner' | 'repo' | 'pr'>): string {
  return `${job.installationId}/${job.owner}/${job.repo}#${job.pr}`;
}
