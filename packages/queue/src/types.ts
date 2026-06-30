export type JobId = string;

export interface ReviewJobPayload {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  action: 'opened' | 'synchronize' | 'reopened' | 'manual';
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
  return `${job.owner}/${job.repo}#${job.pr}@${job.headSha}`;
}

export function prKey(job: Pick<ReviewJobPayload, 'owner' | 'repo' | 'pr'>): string {
  return `${job.owner}/${job.repo}#${job.pr}`;
}
