import { listInstallationRepos, type GitHubAppConfig } from '@orvex-review/github';
import type {
  InstallationRepositoriesWebhook,
  InstallationWebhook,
} from './github-webhook-contracts.js';
import type { GitHubWebhookEventContext } from './github-webhook-event-context.js';

export async function handleInstallationEvent(
  context: GitHubWebhookEventContext,
  githubConfig: GitHubAppConfig,
  data: InstallationWebhook,
): Promise<Record<string, unknown>> {
  const installation = data.installation;
  if (!installation?.id) return { ok: true };
  if (data.action === 'deleted') {
    context.db.disableReposForInstallation(installation.id);
    const existing = context.db.getInstallation(installation.id);
    if (existing) {
      context.db.upsertInstallation({
        installationId: installation.id,
        tenantId: existing.tenantId,
        accountLogin: installation.account?.login ?? 'unknown',
        accountType: installation.account?.type ?? 'Organization',
        repositorySelection: installation.repository_selection ?? 'selected',
        suspendedAt: new Date().toISOString(),
      });
    }
    return { ok: true, action: 'deleted' };
  }
  const bound = await context.tenants.syncInstallationFromWebhook(installation.id, null, {
    accountLogin: installation.account?.login ?? 'unknown',
    accountType: installation.account?.type ?? 'Organization',
    repositorySelection: installation.repository_selection ?? 'selected',
    suspendedAt: installation.suspended_at ?? null,
  });
  context.syncReposFromPayload(
    installation.id,
    (data as InstallationRepositoriesWebhook).repositories ?? [],
  );
  if (bound) {
    try {
      const repos = await listInstallationRepos(githubConfig, installation.id);
      context.syncReposFromPayload(
        installation.id,
        repos.map((repo) => ({
          id: repo.githubRepoId,
          name: repo.name,
          full_name: repo.fullName,
          private: repo.private,
          default_branch: repo.defaultBranch,
        })),
      );
    } catch (error) {
      console.warn(
        `[webhook] full installation repo sync failed for ${installation.id}:`,
        (error as Error).message,
      );
    }
  }
  console.log(
    `[webhook] installation ${data.action} id=${installation.id} account=${installation.account?.login}`,
  );
  return { ok: true, action: data.action };
}

export function handleInstallationRepositoriesEvent(
  context: GitHubWebhookEventContext,
  data: InstallationRepositoriesWebhook,
): Record<string, unknown> {
  const installation = data.installation;
  if (installation?.id) {
    for (const removed of data.repositories_removed ?? [])
      context.db.disableRepoByGitHubId(installation.id, removed.id);
    const added = data.repositories_added ?? [];
    context.syncReposFromPayload(installation.id, [...added, ...(data.repositories ?? [])]);
    if (added.length > 0) {
      const stored = context.db.getInstallation(installation.id);
      if (stored) {
        const settings = context.db.getWorkspaceSettings(stored.tenantId);
        for (const repo of added) {
          if (!repo?.id) continue;
          const existing = context.db.getRepoByGitHubId(installation.id, repo.id);
          if (existing) context.db.setRepoEnabled(existing.id, settings.autoEnableNewRepos);
        }
      }
    }
  }
  console.log(`[webhook] installation_repositories ${data.action}`);
  return { ok: true, action: data.action };
}
