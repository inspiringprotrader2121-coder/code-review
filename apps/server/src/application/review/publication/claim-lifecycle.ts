import type { ReviewPublicationScope } from '@orvex-review/store';
import type { ArtifactPublisher, PublicationRepository, PublicationWriter } from './contracts.js';

export class PublicationInProgressError extends Error {
  constructor(artifactKey: string) {
    super(`publication already in progress for ${artifactKey}`);
    this.name = 'PublicationInProgressError';
  }
}

export class PublicationOwnershipLostError extends Error {
  constructor(artifactKey: string) {
    super(`publication ownership lost for ${artifactKey}`);
    this.name = 'PublicationOwnershipLostError';
  }
}

/** Coordinates local coalescing with the durable tenant/run/artifact claim. */
export class PublicationClaimLifecycle implements ArtifactPublisher {
  private readonly publications = new Map<string, Promise<unknown>>();

  constructor(private readonly repository?: PublicationRepository) {}

  get hasDurableRepository(): boolean {
    return this.repository !== undefined;
  }

  async publish<T>(idempotencyKey: string, write: PublicationWriter<T>): Promise<T> {
    const existing = this.publications.get(idempotencyKey);
    if (existing) return existing as Promise<T>;

    const publication = write();
    this.publications.set(idempotencyKey, publication);
    try {
      return await publication;
    } catch (error) {
      // Known failures may be retried. Successful writes remain memoized so a
      // later local finalizer error cannot trigger another GitHub mutation.
      this.publications.delete(idempotencyKey);
      throw error;
    }
  }

  async publishArtifact<T>(
    scope: Omit<ReviewPublicationScope, 'artifactKey'> | undefined,
    artifactKey: string,
    write: PublicationWriter<T>,
  ): Promise<T> {
    if (!this.repository || !scope) return this.publish(artifactKey, write);

    const claimScope = { ...scope, artifactKey };
    const localKey = `${scope.tenantId}:${scope.runId}:${artifactKey}`;
    const claim = this.repository.claimReviewPublication(claimScope);
    if (claim.status === 'published')
      return this.parseStoredResult<T>(claim.resultJson, artifactKey);
    if (claim.status === 'in_progress') throw new PublicationInProgressError(artifactKey);
    if (claim.status === 'not_owner') throw new PublicationOwnershipLostError(artifactKey);

    let result: T;
    try {
      result = await this.publish(localKey, write);
    } catch (error) {
      // A known failed external write is safe to release for a retry. Both the
      // active run owner and claim token are checked by the repository.
      this.repository.releaseReviewPublication({ ...claimScope, claimToken: claim.claimToken });
      throw error;
    }

    // A write which returned after ownership loss is deliberately left
    // ambiguous. Releasing it could produce a duplicate GitHub mutation.
    const resultJson = JSON.stringify(result ?? null);
    if (
      !this.repository.completeReviewPublication({
        ...claimScope,
        claimToken: claim.claimToken,
        resultJson,
      })
    ) {
      throw new PublicationOwnershipLostError(artifactKey);
    }
    return result;
  }

  private parseStoredResult<T>(resultJson: string | null, artifactKey: string): T {
    try {
      return JSON.parse(resultJson ?? 'null') as T;
    } catch {
      throw new Error(`invalid stored publication result for ${artifactKey}`);
    }
  }
}
