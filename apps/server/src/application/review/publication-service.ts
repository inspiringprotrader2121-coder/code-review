import type { ReviewPublicationRepository } from '@orvex-review/store';
import {
  PublicationClaimLifecycle,
  PublicationInProgressError,
  PublicationOwnershipLostError,
} from './publication/claim-lifecycle.js';
import type {
  PublicationInput,
  PublicationPolicy,
  PublicationWriter,
} from './publication/contracts.js';
import { DEFAULT_PUBLICATION_POLICY } from './publication/contracts.js';
import { publishFixedReplies } from './publication/fixed-replies.js';
import { formatInlineBody } from './publication/inline-comments.js';
import { publishReview } from './publication/review-publication.js';
import { mayPublishRuntimeEvidence } from './publication/runtime-evidence.js';

export {
  DEFAULT_PUBLICATION_POLICY,
  PublicationInProgressError,
  PublicationOwnershipLostError,
  formatInlineBody,
  mayPublishRuntimeEvidence,
};
export type { PublicationInput, PublicationPolicy, PublicationWriter };

/**
 * Stable review-facing facade. Publication behavior is implemented by focused
 * claim, GitHub-output, state, check-run, runtime-evidence, and reply modules.
 */
export class PublicationService {
  private readonly lifecycle: PublicationClaimLifecycle;

  constructor(repository?: ReviewPublicationRepository) {
    this.lifecycle = new PublicationClaimLifecycle(repository);
  }

  publish<T>(idempotencyKey: string, write: PublicationWriter<T>): Promise<T> {
    return this.lifecycle.publish(idempotencyKey, write);
  }

  publishArtifact<T>(
    scope: Parameters<PublicationClaimLifecycle['publishArtifact']>[0],
    artifactKey: string,
    write: PublicationWriter<T>,
  ): Promise<T> {
    return this.lifecycle.publishArtifact(scope, artifactKey, write);
  }

  publishFixedReplies(input: Parameters<typeof publishFixedReplies>[1]): Promise<void> {
    return publishFixedReplies(this.lifecycle, input);
  }

  publishReview(input: PublicationInput) {
    if (!this.lifecycle.hasDurableRepository) {
      return Promise.reject(new Error('durable publication requires a review run and repository'));
    }
    return publishReview(this.lifecycle, input);
  }
}
