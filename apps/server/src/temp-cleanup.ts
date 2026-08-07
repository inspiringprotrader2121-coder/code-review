import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listActiveReviewEntries } from './active-reviews.js';

// Directory prefixes for abandoned agent checkouts swept by temp-cleanup.
// NOTE: `orvex-rv-` is intentionally ABSENT — that prefix names the live Docker
// sandbox CONTAINERS, not a checkout dir, and sweeping it could delete a
// workdir a running container still has mounted. runtime-verify workdirs use
// the distinct `orvex-rverify-` prefix instead.
const AGENT_TEMP_PREFIXES = ['orvex-repo-', 'orvex-rverify-', 'orvex-codex-'];
const DEFAULT_MAX_AGE_MS = 24 * 3_600_000;

/** Remove abandoned read-only agent checkouts left by a crashed worker. */
export function cleanupAbandonedAgentCheckouts(
  tempRoot = os.tmpdir(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
): number {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch (err) {
    console.warn(`[server] abandoned agent checkout cleanup failed for ${tempRoot}:`, (err as Error).message);
    return 0;
  }
  const activeCheckoutDirs = new Set<string>();
  for (const review of listActiveReviewEntries()) {
    for (const dir of review.checkoutDirs) {
      activeCheckoutDirs.add(path.resolve(dir));
    }
  }
  for (const entry of entries) {
        if (!entry.isDirectory() || !AGENT_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const fullPath = path.resolve(path.join(tempRoot, entry.name));
    if (activeCheckoutDirs.has(fullPath)) continue;
    try {
      const age = now - fs.statSync(fullPath).mtimeMs;
      if (Number.isFinite(age) && age >= maxAgeMs) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removed += 1;
      }
    } catch (err) {
      console.warn(`[server] abandoned agent checkout cleanup failed for ${fullPath}:`, (err as Error).message);
    }
  }
  return removed;
}
