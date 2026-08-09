import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { createBenchmarkOctokit } from '../bench/github-auth.js';
import type { EvaluationLogger } from './types.js';

/** Downloads an immutable head snapshot solely for the read-only investigate loop. */
export async function checkoutEvalRepo(
  octokit: Awaited<ReturnType<typeof createBenchmarkOctokit>>,
  owner: string,
  repo: string,
  sha: string,
  logger: EvaluationLogger,
): Promise<string | null> {
  let directory: string | null = null;
  try {
    const response = await octokit.rest.repos.downloadTarballArchive({ owner, repo, ref: sha });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-eval-'));
    const tarPath = path.join(directory, 'repo.tar.gz');
    fs.writeFileSync(tarPath, Buffer.from(response.data as ArrayBuffer));
    execFileSync('tar', ['-xzf', tarPath, '-C', directory, '--strip-components=1'], {
      stdio: 'ignore',
    });
    fs.rmSync(tarPath, { force: true });
    return directory;
  } catch (error) {
    if (directory) removeCheckout(directory);
    logger.log(`    investigate checkout failed: ${(error as Error).message.slice(0, 120)}`);
    return null;
  }
}

export function removeCheckout(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // A checkout failure must never stop the normal, controlled evaluation.
  }
}
