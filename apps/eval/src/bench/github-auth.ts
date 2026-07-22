import { Octokit } from '@octokit/rest';
import {
  createInstallationOctokit,
  getInstallationIdForRepo,
  loadGitHubConfigFromEnv,
} from '@orvex-review/github';

/** GitHub client for local benchmark tools. An explicitly supplied token lets
 * the harness use the developer's existing `gh` login; production continues to
 * use the GitHub App installation path unchanged. */
export async function createBenchmarkOctokit(owner: string, repo: string): Promise<Octokit> {
  const token = process.env.BENCH_GITHUB_TOKEN;
  if (token) return new Octokit({ auth: token });

  const config = loadGitHubConfigFromEnv();
  const installationId =
    Number(process.env.ORVEX_INSTALL_ID) || (await getInstallationIdForRepo(config, owner, repo));
  return createInstallationOctokit(config, installationId);
}
