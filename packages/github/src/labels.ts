import type { Octokit } from '@octokit/rest';
import type { PrRef } from './types.js';

export async function fetchPrLabels(octokit: Octokit, ref: PrRef): Promise<string[]> {
  const { data } = await octokit.rest.issues.listLabelsOnIssue({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
  });
  return data.map((l) => l.name);
}

export function hasIgnoreLabel(labels: string[], ignoreLabels: string[]): boolean {
  const lower = new Set(labels.map((l) => l.toLowerCase()));
  return ignoreLabels.some((il) => lower.has(il.toLowerCase()));
}
