/**
 * Live registry of in-flight client reviews for the super-admin monitor.
 *
 * Tracks each FULL review job (not individual model passes): identity, elapsed
 * time, checkout disk, and associated Codex child processes. Host CPU/RAM/disk
 * are sampled on read. Node RSS is shared across concurrent jobs and is shown
 * both as a host total and as an equal-share estimate per review.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReviewJobPayload } from '@orvex-review/queue';
import { prKey } from '@orvex-review/queue';

export interface ActiveReviewEntry {
  id: string;
  job: ReviewJobPayload;
  startedAtMs: number;
  checkoutDirs: Set<string>;
  childPids: Set<number>;
  /** Per-review cancellation. Never use the global Codex shutdown kill for a
   *  PR lifecycle event because that would terminate other tenants' reviews. */
  abortController: AbortController;
}

export interface ActiveReviewSample {
  id: string;
  kind: string;
  action: string;
  deep: boolean;
  runId: string | null;
  tenantId: string;
  installationId: number;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  prKey: string;
  startedAt: string;
  elapsedMs: number;
  checkoutDiskBytes: number;
  childCount: number;
  childRssBytes: number;
  /** Equal share of this worker's RSS across concurrent reviews (estimate). */
  estimatedNodeRssShareBytes: number;
  children: Array<{ pid: number; rssBytes: number }>;
}

export interface HostResourceSample {
  sampledAt: string;
  cpuCount: number;
  loadAverage: [number, number, number];
  memory: {
    totalBytes: number;
    freeBytes: number;
    availableBytes: number;
    usedBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  disk: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    availableBytes: number;
    usedBytes: number;
  };
  worker: {
    pid: number;
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    activeReviews: number;
    maxConcurrentReviews: number;
  };
}

export interface ActiveReviewsSnapshot {
  host: HostResourceSample;
  reviews: ActiveReviewSample[];
}

const als = new AsyncLocalStorage<string>();
const entries = new Map<string, ActiveReviewEntry>();

function newId(job: ReviewJobPayload): string {
  return `${prKey(job)}:${job.kind ?? 'review'}:${job.enqueuedAt ?? Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

/** Register a job for live monitoring and bind AsyncLocalStorage for this async stack. */
export function runWithActiveReview<T>(job: ReviewJobPayload, fn: () => Promise<T>): Promise<T> {
  const id = newId(job);
  const entry: ActiveReviewEntry = {
    id,
    job,
    startedAtMs: Date.now(),
    checkoutDirs: new Set(),
    childPids: new Set(),
    abortController: new AbortController(),
  };
  entries.set(id, entry);
  return als.run(id, async () => {
    try {
      return await fn();
    } finally {
      entries.delete(id);
    }
  });
}

/** Signal bound to the review currently executing in this async stack. */
export function activeReviewSignal(): AbortSignal | undefined {
  const id = als.getStore();
  return id ? entries.get(id)?.abortController.signal : undefined;
}

/**
 * Cancel only the matching in-flight review(s). The close/merge webhook uses
 * this for immediate same-process cancellation; the pipeline's GitHub poll is
 * retained as a process-independent fallback.
 */
export function cancelActiveReviewsForPr(
  key: Pick<ReviewJobPayload, 'installationId' | 'owner' | 'repo' | 'pr'>,
  reason = 'pr_closed_mid_run',
): number {
  let cancelled = 0;
  for (const entry of entries.values()) {
    const job = entry.job;
    if (
      (job.kind ?? 'review') !== 'review' ||
      job.installationId !== key.installationId ||
      job.pr !== key.pr ||
      job.owner.toLowerCase() !== key.owner.toLowerCase() ||
      job.repo.toLowerCase() !== key.repo.toLowerCase() ||
      entry.abortController.signal.aborted
    ) {
      continue;
    }
    entry.abortController.abort(reason);
    cancelled++;
  }
  return cancelled;
}

/** Abort every active job during forced worker shutdown. */
export function cancelAllActiveReviews(reason = 'worker_shutdown'): number {
  let cancelled = 0;
  for (const entry of entries.values()) {
    if (entry.abortController.signal.aborted) continue;
    entry.abortController.abort(reason);
    cancelled++;
  }
  return cancelled;
}

export function noteActiveCheckoutDir(dir: string | null | undefined): void {
  if (!dir) return;
  const id = als.getStore();
  if (!id) return;
  entries.get(id)?.checkoutDirs.add(path.resolve(dir));
}

export function noteActiveChildSpawn(pid: number): void {
  const id = als.getStore();
  if (!id) return;
  entries.get(id)?.childPids.add(pid);
}

export function noteActiveChildExit(pid: number): void {
  for (const entry of entries.values()) entry.childPids.delete(pid);
}

export function listActiveReviewEntries(): ActiveReviewEntry[] {
  return [...entries.values()];
}

export function getActiveReviewCount(): number {
  return entries.size;
}

function parseMeminfo(): {
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
} | null {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const get = (key: string): number | null => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? Number(m[1]) * 1024 : null;
    };
    const available = get('MemAvailable');
    const swapTotal = get('SwapTotal');
    const swapFree = get('SwapFree');
    if (available == null || swapTotal == null || swapFree == null) return null;
    return { availableBytes: available, swapTotalBytes: swapTotal, swapFreeBytes: swapFree };
  } catch {
    return null;
  }
}

function readPidRssBytes(pid: number): number | null {
  try {
    // /proc/<pid>/statm: size resident shared text lib data dt — values in pages
    const text = readFileSync(`/proc/${pid}/statm`, 'utf8').trim();
    const residentPages = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(residentPages) || residentPages < 0) return null;
    return residentPages * 4096;
  } catch {
    return null;
  }
}

/** Bounded recursive disk usage. Caps walk so a huge checkout cannot hang the API. */
export function directorySizeBytes(root: string, opts?: { maxEntries?: number }): number {
  const maxEntries = opts?.maxEntries ?? 50_000;
  let total = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let st;
    try {
      st = statSync(current);
    } catch {
      continue;
    }
    if (st.isFile()) {
      total += st.size;
      seen += 1;
    } else if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(current);
      } catch {
        continue;
      }
      for (const name of names) {
        stack.push(path.join(current, name));
        seen += 1;
        if (seen >= maxEntries) return total;
      }
    }
    if (seen >= maxEntries) return total;
  }
  return total;
}

function diskForPath(target: string): HostResourceSample['disk'] {
  const resolved = path.resolve(target);
  try {
    const s = statfsSync(resolved);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    const availableBytes = Number(s.bavail) * Number(s.bsize);
    const freeBytes = Number(s.bfree) * Number(s.bsize);
    return {
      path: resolved,
      totalBytes,
      freeBytes,
      availableBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
    };
  } catch {
    return {
      path: resolved,
      totalBytes: 0,
      freeBytes: 0,
      availableBytes: 0,
      usedBytes: 0,
    };
  }
}

/** Sample host memory and disk for admission and the live monitor. */
export function sampleHostResources(
  diskPath?: string,
): Pick<HostResourceSample, 'memory' | 'disk'> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const meminfo = parseMeminfo();
  const availableBytes = meminfo?.availableBytes ?? freeBytes;
  const swapTotalBytes = meminfo?.swapTotalBytes ?? 0;
  const swapUsedBytes = meminfo ? meminfo.swapTotalBytes - meminfo.swapFreeBytes : 0;
  const diskRoot = diskPath ?? os.tmpdir();
  return {
    memory: {
      totalBytes,
      freeBytes,
      availableBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
      swapTotalBytes,
      swapUsedBytes,
    },
    disk: diskForPath(existsSync(diskRoot) ? diskRoot : '/'),
  };
}

function sampleHost(
  activeCount: number,
  maxConcurrent: number,
  diskPath?: string,
): HostResourceSample {
  const resources = sampleHostResources(diskPath);
  const mu = process.memoryUsage();
  const load = os.loadavg() as [number, number, number];
  return {
    sampledAt: new Date().toISOString(),
    cpuCount: os.cpus().length,
    loadAverage: load,
    memory: resources.memory,
    disk: resources.disk,
    worker: {
      pid: process.pid,
      rssBytes: mu.rss,
      heapUsedBytes: mu.heapUsed,
      externalBytes: mu.external,
      activeReviews: activeCount,
      maxConcurrentReviews: maxConcurrent,
    },
  };
}

export function sampleActiveReviews(opts?: {
  maxConcurrent?: number;
  diskPath?: string;
}): ActiveReviewsSnapshot {
  const active = listActiveReviewEntries();
  const maxConcurrent = opts?.maxConcurrent ?? 4;
  const host = sampleHost(active.length, maxConcurrent, opts?.diskPath);
  const share =
    active.length > 0 ? Math.floor(host.worker.rssBytes / active.length) : host.worker.rssBytes;
  const reviews: ActiveReviewSample[] = active.map((entry) => {
    const children: Array<{ pid: number; rssBytes: number }> = [];
    let childRssBytes = 0;
    for (const pid of entry.childPids) {
      const rss = readPidRssBytes(pid);
      if (rss == null) continue;
      children.push({ pid, rssBytes: rss });
      childRssBytes += rss;
    }
    let checkoutDiskBytes = 0;
    for (const dir of entry.checkoutDirs) {
      if (!existsSync(dir)) continue;
      checkoutDiskBytes += directorySizeBytes(dir);
    }
    const job = entry.job;
    return {
      id: entry.id,
      kind: job.kind ?? 'review',
      action: job.action,
      deep: Boolean(job.deep),
      runId: job.runId ?? null,
      tenantId: job.tenantId,
      installationId: job.installationId,
      owner: job.owner,
      repo: job.repo,
      pr: job.pr,
      headSha: job.headSha,
      prKey: prKey(job),
      startedAt: new Date(entry.startedAtMs).toISOString(),
      elapsedMs: Date.now() - entry.startedAtMs,
      checkoutDiskBytes,
      childCount: children.length,
      childRssBytes,
      estimatedNodeRssShareBytes: share,
      children,
    };
  });
  reviews.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { host, reviews };
}
