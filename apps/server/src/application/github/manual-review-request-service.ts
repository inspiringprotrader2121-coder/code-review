import { timingSafeEqual } from 'node:crypto';
import type { ReviewJobPayload } from '@orvex-review/queue';

export type ManualReviewRequest = {
  owner?: string;
  repo?: string;
  pr?: number;
  headSha?: string;
  repoSlug?: string;
  installationId?: number;
  tenantSlug?: string;
};

export type ManualReviewTrigger = (input: {
  owner: string;
  repo: string;
  pr: number;
  headSha?: string;
  installationId?: number;
  tenantSlug?: string;
}) => Promise<ReviewJobPayload>;

export type ManualReviewRequestResult =
  | { kind: 'disabled' | 'unauthorized' | 'invalid' | 'unavailable' }
  | { kind: 'accepted'; job: ReviewJobPayload };

/** Authenticates and validates the non-GitHub manual-review API request. */
export class ManualReviewRequestService {
  constructor(
    private readonly reviewApiSecret: string | undefined,
    private readonly trigger: ManualReviewTrigger | undefined,
  ) {}

  async handle(
    bearer: string | undefined,
    request: ManualReviewRequest | null,
  ): Promise<ManualReviewRequestResult> {
    if (!this.reviewApiSecret) return { kind: 'disabled' };
    if (!bearer || !safeEqual(bearer, this.reviewApiSecret)) return { kind: 'unauthorized' };
    if (!request) return { kind: 'invalid' };

    let owner = request.owner;
    let repo = request.repo;
    if (request.repoSlug) [owner, repo] = request.repoSlug.split('/');
    if (
      !owner ||
      !repo ||
      typeof request.pr !== 'number' ||
      !Number.isSafeInteger(request.pr) ||
      request.pr < 1
    ) {
      return { kind: 'invalid' };
    }
    if (
      request.installationId !== undefined &&
      (!Number.isInteger(request.installationId) || request.installationId < 1)
    ) {
      return { kind: 'invalid' };
    }
    if (!this.trigger) return { kind: 'unavailable' };
    return {
      kind: 'accepted',
      job: await this.trigger({
        owner,
        repo,
        pr: request.pr,
        headSha: request.headSha,
        installationId: request.installationId,
        tenantSlug: request.tenantSlug,
      }),
    };
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
