import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ReviewQueue } from '@orvex-review/queue';
import { createAppDatabase } from '@orvex-review/store';
import { createApp } from './app.js';

test('health is live-only while readiness checks both database and queue', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-app-readiness-'));
  const previous = snapshotEnv([
    'STORE_PATH',
    'PLATFORM_SECRET',
    'APP_URL',
    'ORVEX_REQUIRE_LOGIN',
    'ORVEX_CODEX_STATUS_FILE',
  ]);
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.PLATFORM_SECRET = 'test-platform-secret';
  process.env.APP_URL = 'https://useorvex.test';
  process.env.ORVEX_REQUIRE_LOGIN = '1';
  process.env.ORVEX_CODEX_STATUS_FILE = path.join(dir, 'missing-codex-status');
  t.after(() => {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  });

  let queueUp = true;
  const queue = {
    ping: async () => queueUp,
  } as unknown as ReviewQueue;
  const app = createApp(queue);

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
  });

  createAppDatabase().close();
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
