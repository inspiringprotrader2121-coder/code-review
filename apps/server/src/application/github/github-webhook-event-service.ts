import { createHash } from 'node:crypto';
import type { ReviewQueue } from '@orvex-review/queue';
import { GitHubCommentCommandService } from './github-comment-command-service.js';
import type {
  GithubWebhookEventDependencies,
  GithubWebhookEventResult,
} from './github-webhook-contracts.js';
import { GitHubWebhookEventContext } from './github-webhook-event-context.js';
import {
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
} from './installation-events.js';
import { handlePullRequestEvent } from './pull-request-events.js';

export type {
  GithubWebhookEventDependencies,
  GithubWebhookEventResult,
  WebhookRouteDependencies,
  WebhookRepositoryStore,
} from './github-webhook-contracts.js';

/** sha256(event + NUL + body) closes delivery-id rotation replay. */
export function githubWebhookBodyHash(event: string | undefined, rawBody: string): string {
  return createHash('sha256')
    .update(event ?? '')
    .update('\0')
    .update(rawBody)
    .digest('hex');
}

/** Stable application dispatcher: event-specific decisions live in cohesive use-case modules. */
export interface GithubWebhookEventService {
  dispatch(
    event: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<GithubWebhookEventResult>;
}

export function createGithubWebhookEventService(
  queue: ReviewQueue,
  dependencies: GithubWebhookEventDependencies,
): GithubWebhookEventService {
  const context = new GitHubWebhookEventContext(queue, dependencies);
  const comments = new GitHubCommentCommandService(context);

  return {
    async dispatch(event, payload) {
      const githubConfig = context.getGitHubConfig();
      switch (event) {
        case 'installation':
          return { body: await handleInstallationEvent(context, githubConfig, payload as never) };
        case 'installation_repositories':
          return { body: handleInstallationRepositoriesEvent(context, payload as never) };
        case 'issue_comment':
          return {
            body: {
              ok: true,
              outcome: await comments.handleIssueComment(githubConfig, payload as never),
            },
          };
        case 'pull_request_review_comment': {
          const outcome = await comments.handleReviewComment(githubConfig, payload as never);
          console.log(
            `[webhook] review_comment action=${(payload as { action?: string }).action} outcome=${outcome}`,
          );
          return { body: { ok: true, outcome } };
        }
        case 'pull_request':
          return handlePullRequestEvent(context, githubConfig, payload as never);
        default:
          return { body: { ok: true, ignored: event ?? 'unknown' } };
      }
    },
  };
}
