export type JobId = string;

export type JobKind = 'review' | 'fix' | 'explain' | 'ask' | 'resolve';

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
  close(): Promise<void>;
}

export function jobIdempotencyKey(job: ReviewJobPayload): string {
  const kind = job.kind ?? 'review';
  const base = `${job.installationId}/${job.owner}/${job.repo}#${job.pr}@${job.headSha}`;
  if (kind === 'review') return base;
  const fix = job.fix;
  return `${base}:${kind}:${fix?.scope ?? 'ready'}:${fix?.fingerprint ?? ''}:${fix?.replyToCommentId ?? ''}`;
}

export function prKey(job: Pick<ReviewJobPayload, 'installationId' | 'owner' | 'repo' | 'pr'>): string {
  return `${job.installationId}/${job.owner}/${job.repo}#${job.pr}`;
}
