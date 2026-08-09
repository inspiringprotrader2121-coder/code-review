import type {
  ReviewPublicationOperatorRepository,
  ReviewPublicationResolution,
} from '@orvex-review/store';

const ABANDONED_PUBLICATION_MS = 15 * 60_000;
const MAX_RESULT_BYTES = 16_384;

export interface PublicationResolutionRequest {
  tenantId?: unknown;
  runId?: unknown;
  artifactKey?: unknown;
  action?: unknown;
  reason?: unknown;
  result?: unknown;
  resultProvided: boolean;
}

export type PublicationResolutionResult =
  | { kind: 'resolved'; action: ReviewPublicationResolution['action'] }
  | { kind: 'invalid'; error: string }
  | { kind: 'conflict' };

export class PublicationOperatorService {
  constructor(
    private readonly repository: ReviewPublicationOperatorRepository,
    private readonly now: () => number = Date.now,
  ) {}

  list(limit = 100) {
    return {
      claims: this.repository.listAbandonedReviewPublications(this.abandonedBefore(), limit),
      resolutions: this.repository.listReviewPublicationResolutions(limit),
    };
  }

  resolve(request: PublicationResolutionRequest, actor: string): PublicationResolutionResult {
    const tenantId = boundedString(request.tenantId, 200);
    const runId = boundedString(request.runId, 200);
    const artifactKey = boundedString(request.artifactKey, 512);
    const reason = boundedString(request.reason, 500);
    if (!tenantId || !runId || !artifactKey || !reason) {
      return { kind: 'invalid', error: 'tenantId, runId, artifactKey, and reason are required' };
    }
    const action =
      request.action === 'retry'
        ? 'retry'
        : request.action === 'mark-published'
          ? 'mark_published'
          : null;
    if (!action) return { kind: 'invalid', error: 'action must be retry or mark-published' };

    const result =
      action === 'mark_published'
        ? publicationResultJson(artifactKey, request.resultProvided, request.result)
        : { ok: true as const, resultJson: undefined };
    if (!result.ok) return { kind: 'invalid', error: result.error };

    const resolved = this.repository.resolveAbandonedReviewPublication({
      tenantId,
      runId,
      artifactKey,
      action,
      actor,
      reason,
      abandonedBefore: this.abandonedBefore(),
      resultJson: result.resultJson,
    });
    return resolved ? { kind: 'resolved', action } : { kind: 'conflict' };
  }

  private abandonedBefore(): string {
    return new Date(this.now() - ABANDONED_PUBLICATION_MS).toISOString();
  }
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function publicationResultJson(
  artifactKey: string,
  provided: boolean,
  value: unknown,
): { ok: true; resultJson: string | null } | { ok: false; error: string } {
  if (!provided) return { ok: false, error: 'mark-published requires the verified GitHub result' };

  let normalized: unknown;
  if (artifactKey.startsWith('review:')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'review result must contain reviewId, reviewUrl, and commentIds' };
    }
    const candidate = value as { reviewId?: unknown; reviewUrl?: unknown; commentIds?: unknown };
    if (
      !positiveInteger(candidate.reviewId) ||
      !httpsUrl(candidate.reviewUrl) ||
      !Array.isArray(candidate.commentIds)
    ) {
      return { ok: false, error: 'review result must contain reviewId, reviewUrl, and commentIds' };
    }
    const commentIds = candidate.commentIds.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const comment = item as { path?: unknown; line?: unknown; id?: unknown };
      if (
        typeof comment.path !== 'string' ||
        comment.path.length > 4096 ||
        !positiveInteger(comment.line) ||
        !positiveInteger(comment.id)
      )
        return [];
      return [{ path: comment.path, line: comment.line, id: comment.id }];
    });
    if (commentIds.length !== candidate.commentIds.length || commentIds.length > 1000) {
      return { ok: false, error: 'review commentIds are invalid' };
    }
    normalized = { reviewId: candidate.reviewId, reviewUrl: candidate.reviewUrl, commentIds };
  } else if (artifactKey.startsWith('check:') || artifactKey.startsWith('unanchored:')) {
    if (!positiveInteger(value))
      return { ok: false, error: 'this artifact requires a positive GitHub id' };
    normalized = value;
  } else if (
    artifactKey.startsWith('fixed-reply:') ||
    artifactKey.startsWith('runtime-evidence:')
  ) {
    if (value !== null) return { ok: false, error: 'this artifact requires a null result' };
    normalized = null;
  } else {
    return { ok: false, error: 'unknown publication artifact type' };
  }

  const resultJson = JSON.stringify(normalized);
  if (Buffer.byteLength(resultJson, 'utf8') > MAX_RESULT_BYTES) {
    return { ok: false, error: 'verified GitHub result is too large' };
  }
  return { ok: true, resultJson };
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
