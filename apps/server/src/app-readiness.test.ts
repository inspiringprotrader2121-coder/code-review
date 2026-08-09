import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ReviewQueue } from '@orvex-review/queue';
import { AppDatabase, createAppDatabase } from '@orvex-review/store';
import { createApp, DEFAULT_RELEASE_FILE } from './app.js';

test('default release metadata path is rooted at the deployed repository', () => {
  assert.equal(path.basename(DEFAULT_RELEASE_FILE), 'release.json');
  assert.equal(path.dirname(DEFAULT_RELEASE_FILE), path.resolve(process.cwd(), '../..'));
});

test('health is live-only while readiness checks both database and queue', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-app-readiness-'));
  const previous = snapshotEnv([
    'STORE_PATH',
    'PLATFORM_SECRET',
    'APP_URL',
    'ORVEX_REQUIRE_LOGIN',
    'ORVEX_CODEX_STATUS_FILE',
    'ORVEX_DEPLOY_DRAIN_PATH',
  ]);
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret';
  process.env.APP_URL = 'https://useorvex.test';
  process.env.ORVEX_REQUIRE_LOGIN = '1';
  process.env.ORVEX_CODEX_STATUS_FILE = path.join(dir, 'missing-codex-status');
  process.env.ORVEX_DEPLOY_DRAIN_PATH = path.join(dir, 'deploy-drain');
  t.after(() => {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  });

  let queueUp = true;
  const queue = {
    ping: async () => queueUp,
  } as unknown as ReviewQueue;
  const app = createApp(queue, { releaseFile: path.join(dir, 'missing-release.json') });

  const health = await app.request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: 'orvex-review',
    mode: 'multi-tenant',
    connect: '/connect',
  });

  const ready = await app.request('/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    ok: true,
    db: 'ok',
    queue: 'ok',
    activeJobs: 0,
    draining: false,
    codexAuth: 'unknown',
    releaseId: 'unknown',
  });

  queueUp = false;
  const notReady = await app.request('/ready');
  assert.equal(notReady.status, 503);
  assert.deepEqual(await notReady.json(), {
    ok: false,
    db: 'ok',
    queue: 'down',
    activeJobs: 0,
    draining: false,
    codexAuth: 'unknown',
    releaseId: 'unknown',
  });

  createAppDatabase().close();
});

test('readiness reports Redis-wide in-flight work from the queue ledger', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-app-global-ready-'));
  const db = new AppDatabase(':memory:');
  const queue = {
    async ping() { return true; },
    async depth() { return { queued: 2, waitingOnPr: 1, inFlight: 4, oldestQueuedAt: null }; },
  } as unknown as ReviewQueue;
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const app = createApp(queue, { db, releaseFile: path.join(dir, 'missing-release.json') });
  const ready = await app.request('/ready');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json() as Record<string, unknown>).activeJobs, 4);
});

test('readiness fails closed when the queue-wide activity probe cannot be read', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-app-global-ready-fail-'));
  const db = new AppDatabase(':memory:');
  const queue = {
    async ping() { return true; },
    async depth() { throw new Error('Redis depth unavailable'); },
  } as unknown as ReviewQueue;
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const app = createApp(queue, { db, releaseFile: path.join(dir, 'missing-release.json') });
  const ready = await app.request('/ready');
  assert.equal(ready.status, 503);
  assert.equal((await ready.json() as Record<string, unknown>).queue, 'down');
});

test('readiness exposes only a valid release identity from injected metadata', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-release-readiness-'));
  const releaseFile = path.join(dir, 'release.json');
  const db = new AppDatabase(':memory:');
  const queue = { ping: async () => true } as unknown as ReviewQueue;
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(releaseFile, JSON.stringify({
    releaseId: 'c9471fdb',
    buildTimestamp: '2026-08-09T12:00:00.000Z',
    apiKey: 'must-not-appear-in-readiness',
  }));
  const app = createApp(queue, { db, releaseFile });
  const ready = await app.request('/ready');
  assert.equal(ready.status, 200);
  const body = await ready.json() as Record<string, unknown>;
  assert.equal(body.releaseId, 'c9471fdb');
  assert.equal(JSON.stringify(body).includes('must-not-appear-in-readiness'), false);

  writeFileSync(releaseFile, '{not-json');
  const malformed = await app.request('/ready');
  assert.equal((await malformed.json() as Record<string, unknown>).releaseId, 'unknown');
});

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
