import type { Octokit } from '@octokit/rest';
import type { PrRef } from './types.js';

export type CheckConclusion = 'success' | 'neutral' | 'failure';

export async function createCheckRun(
  octokit: Octokit,
  ref: PrRef,
  headSha: string,
  opts: {
    name?: string;
    conclusion: CheckConclusion;
    title: string;
    summary: string;
  },
): Promise<number> {
  const { data } = await octokit.rest.checks.create({
    owner: ref.owner,
    repo: ref.repo,
    name: opts.name ?? 'velatrix-review',
    head_sha: headSha,
    status: 'completed',
    conclusion: opts.conclusion,
    output: {
      title: opts.title,
      summary: opts.summary,
    },
  });
  return data.id;
}
