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
  /** Stable webhook identity used to deduplicate a retried command delivery. */
  sourceEventId?: string;
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
  action: 'opened' | 'synchronize' | 'reopened' | 'ready_for_review' | 'manual' | 'command';
  fix?: FixRequest;
  enqueuedAt: string;
  /** `@orvex deep`: run extra diverse lens passes and union the results (paid plans) */
  deep?: boolean;
  /** UTC calendar day used to deduplicate one nightly scan per repo. */
  scanDay?: string;
  /** SQLite review-run id to resume after a graceful restart interrupted work. */
  runId?: string;
  /** set when this job was re-queued after a restart interrupted it — a job may
   *  be resumed at most ONCE, so a crash/restart loop can't re-run it forever */
  resumedAfterRestart?: boolean;
  /** transient-failure retry counter — bounds how many times a job is re-queued
   *  after a rate-limit/network blip so a persistent failure can't loop forever */
  attempts?: number;
  /** Stable source identity for webhook-originated command jobs. */
  sourceEventId?: string;
}

export interface EnqueueResult {
  accepted: boolean;
  jobId: JobId;
  reason?: 'duplicate' | 'coalesced' | 'enqueued';
}

export interface MarkCompletedOptions {
  /** Draft auto-triggers skip without reviewing — must NOT mark the bare SHA
   *  DONE, or `ready_for_review` / a later real review of the same head is
   *  blocked. Marks `${shaKey}:draft_skipped` instead. */
  draftSkipped?: boolean;
}

export interface QueueDepth {
  /** Jobs waiting on the main queue (ready to claim). */
  queued: number;
  /** Jobs waiting behind an in-flight PR (coalesced / blocked). */
  waitingOnPr: number;
  /** Jobs currently claimed / in-flight on this queue backend. */
  inFlight: number;
  /** Oldest enqueuedAt among queued jobs, if known. */
  oldestQueuedAt?: string | null;
}

export interface ReviewQueue {
  enqueue(job: ReviewJobPayload): Promise<EnqueueResult>;
  dequeue(): Promise<ReviewJobPayload | null>;
  markCompleted(job: ReviewJobPayload, opts?: MarkCompletedOptions): Promise<void>;
  /** Extend this job's in-flight lease while it is still running.
   *  The Redis lease is a fixed TTL taken at claim time; a long review can
   *  outlive it, at which point another worker's SET NX succeeds and the SAME
   *  PR is reviewed twice — duplicate GitHub comments and a double overage
   *  charge. Callers heartbeat this; implementations without a lease no-op. */
  renewLease?(job: ReviewJobPayload): Promise<void>;
  /** Persist in-memory job mutations (e.g. runId after reserve) into the durable
   *  PROCESSING backup so recoverOrphans requeues with the same resume identity. */
  persistJob?(job: ReviewJobPayload): Promise<void>;
  markFailed(job: ReviewJobPayload, error: string): Promise<void>;
  releaseLockAndDrain(prKey: string): Promise<ReviewJobPayload | null>;
  /** Startup cleanup: clear stale in-flight locks + requeue pending. Returns count. */
  recoverOrphans(): Promise<number>;
  /** Snapshot of waiting / in-flight work for the operator monitor. */
  depth?(): Promise<QueueDepth>;
  /** Liveness probe for /health — true if the backing store is reachable. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Bare SHA key shared by automatic reviews of the same head (opened / ready / …). */
export function reviewShaIdempotencyKey(
  job: Pick<ReviewJobPayload, 'installationId' | 'owner' | 'repo' | 'pr' | 'headSha'>,
): string {
  return `${job.installationId}/${job.owner}/${job.repo}#${job.pr}@${job.headSha}`;
}

export function draftSkipIdempotencyKey(job: ReviewJobPayload): string {
  return `${reviewShaIdempotencyKey(job)}:draft_skipped`;
}

export function jobIdempotencyKey(job: ReviewJobPayload): string {
  const kind = job.kind ?? 'review';
  const base = reviewShaIdempotencyKey(job);
  const fix = job.fix;
  if (kind === 'scan') {
    return `${base}:scan:${job.scanDay ?? job.enqueuedAt.slice(0, 10)}`;
  }
  // Explicit human triggers (`@orvex review` command, CLI manual) must ALWAYS
  // run — never dedup them against an earlier automatic review of the same sha.
  // Only automatic webhook events (opened/synchronize/reopened) dedup.
  if (job.action === 'command' || job.action === 'manual') {
    const source = job.sourceEventId ?? fix?.sourceEventId;
    return `${base}:${kind}:${source ? `event:${hashShort(source)}` : job.enqueuedAt}`;
  }
  // Distinct SEEN/DONE key so draft `opened` (which used to mark bare SHA DONE)
  // cannot block `ready_for_review`. Successful completion ALSO marks the bare
  // SHA DONE (see markCompleted) so opened↔ready cannot double-review.
  if (job.action === 'ready_for_review' && kind === 'review') {
    return `${base}:ready_for_review`;
  }
  if (kind === 'review') return base;
  // include instruction so two different free-form `@orvex <x>` replies on the
  // same thread aren't collapsed into one and silently deduped.
  const instr = fix?.instruction ? `:${hashShort(fix.instruction)}` : '';
  return `${base}:${kind}:${fix?.scope ?? 'ready'}:${fix?.fingerprint ?? ''}:${fix?.replyToCommentId ?? ''}${instr}`;
}

/** True when this automatic review should be rejected because the same SHA
 *  already completed successfully (bare key DONE). */
export function automaticReviewAlreadyDone(
  job: ReviewJobPayload,
  isDone: (key: string) => boolean,
): boolean {
  const kind = job.kind ?? 'review';
  if (kind !== 'review') return false;
  if (job.action === 'command' || job.action === 'manual') return false;
  const bare = reviewShaIdempotencyKey(job);
  const idKey = jobIdempotencyKey(job);
  if (isDone(idKey)) return true;
  // ready_for_review uses a distinct key — still suppress if opened (or a prior
  // ready) already successfully reviewed this SHA.
  if (idKey !== bare && isDone(bare)) return true;
  return false;
}

function hashShort(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function prKey(job: Pick<ReviewJobPayload, 'installationId' | 'owner' | 'repo' | 'pr'>): string {
  return `${job.installationId}/${job.owner}/${job.repo}#${job.pr}`;
}
