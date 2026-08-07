import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ReviewQueue } from '@orvex-review/queue';

test('a failed GitHub delivery is retryable while a successful delivery is deduplicated', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-webhook-dedup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previousEnv = {
    storePath: process.env.STORE_PATH,
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  };
  t.after(() => {
    restoreEnv('STORE_PATH', previousEnv.storePath);
    restoreEnv('GITHUB_APP_ID', previousEnv.appId);
    restoreEnv('GITHUB_APP_PRIVATE_KEY', previousEnv.privateKey);
    restoreEnv('GITHUB_WEBHOOK_SECRET', previousEnv.webhookSecret);
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
  process.env.GITHUB_WEBHOOK_SECRET = 'webhook-test-secret';

  const queue = {
    enqueue: async () => ({ accepted: true, jobId: 'job', reason: 'enqueued' as const }),
  } as unknown as ReviewQueue;
  const { webhookRoutes } = await import('./webhook.js');
  const app = webhookRoutes(queue);
  app.onError((_err, c) => c.json({ error: 'internal server error' }, 500));

  const request = (body: string, delivery: string) =>
    app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': delivery,
        'x-hub-signature-256': sign(body),
      },
      body,
    });

  const malformed = '{';
  assert.equal((await request(malformed, 'failed-delivery')).status, 500);
  assert.equal(
    (await request(malformed, 'failed-delivery')).status,
    500,
    'the retry must be processed again, not falsely acknowledged as a duplicate',
  );

  const valid = '{}';
  const first = await request(valid, 'successful-delivery');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, ignored: 'ping' });
  const duplicate = await request(valid, 'successful-delivery');
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ok: true, deduped: true });

  const restarted = webhookRoutes(queue);
  const afterRestart = await restarted.request('/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'ping',
      'x-github-delivery': 'successful-delivery',
      'x-hub-signature-256': sign(valid),
    },
    body: valid,
  });
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(await afterRestart.json(), { ok: true, deduped: true });
});

test('signed webhooks without X-GitHub-Delivery are rejected', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-webhook-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previousEnv = {
    storePath: process.env.STORE_PATH,
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  };
  t.after(() => {
    restoreEnv('STORE_PATH', previousEnv.storePath);
    restoreEnv('GITHUB_APP_ID', previousEnv.appId);
    restoreEnv('GITHUB_APP_PRIVATE_KEY', previousEnv.privateKey);
    restoreEnv('GITHUB_WEBHOOK_SECRET', previousEnv.webhookSecret);
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
  process.env.GITHUB_WEBHOOK_SECRET = 'webhook-test-secret';

  const queue = {
    enqueue: async () => ({ accepted: true, jobId: 'job', reason: 'enqueued' as const }),
  } as unknown as ReviewQueue;
  const { webhookRoutes } = await import('./webhook.js');
  const app = webhookRoutes(queue);
  const body = '{}';
  const res = await app.request('/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'ping',
      'x-hub-signature-256': sign(body),
    },
    body,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'missing X-GitHub-Delivery' });
});

test('signed body replay with a rotated delivery id is deduped by body hash', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-webhook-body-hash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previousEnv = {
    storePath: process.env.STORE_PATH,
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    bodyTtl: process.env.ORVEX_WEBHOOK_BODY_DEDUP_TTL_MS,
  };
  t.after(() => {
    restoreEnv('STORE_PATH', previousEnv.storePath);
    restoreEnv('GITHUB_APP_ID', previousEnv.appId);
    restoreEnv('GITHUB_APP_PRIVATE_KEY', previousEnv.privateKey);
    restoreEnv('GITHUB_WEBHOOK_SECRET', previousEnv.webhookSecret);
    restoreEnv('ORVEX_WEBHOOK_BODY_DEDUP_TTL_MS', previousEnv.bodyTtl);
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
  process.env.GITHUB_WEBHOOK_SECRET = 'webhook-test-secret';
  process.env.ORVEX_WEBHOOK_BODY_DEDUP_TTL_MS = String(60 * 60_000);

  const queue = {
    enqueue: async () => ({ accepted: true, jobId: 'job', reason: 'enqueued' as const }),
  } as unknown as ReviewQueue;
  const { webhookRoutes } = await import('./webhook.js');
  const app = webhookRoutes(queue);

  const body = '{"zen":"design for failure"}';
  const request = (delivery: string) =>
    app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': delivery,
        'x-hub-signature-256': sign(body),
      },
      body,
    });

  const first = await request('delivery-original');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, ignored: 'ping' });

  const replay = await request('delivery-rotated-by-attacker');
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, deduped: true, reason: 'body' });
});

test('POST /review compares the bearer secret in constant time', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-review-bearer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previousEnv = {
    storePath: process.env.STORE_PATH,
    reviewSecret: process.env.REVIEW_API_SECRET,
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  };
  t.after(() => {
    restoreEnv('STORE_PATH', previousEnv.storePath);
    restoreEnv('REVIEW_API_SECRET', previousEnv.reviewSecret);
    restoreEnv('GITHUB_APP_ID', previousEnv.appId);
    restoreEnv('GITHUB_APP_PRIVATE_KEY', previousEnv.privateKey);
    restoreEnv('GITHUB_WEBHOOK_SECRET', previousEnv.webhookSecret);
  });
  process.env.STORE_PATH = path.join(dir, 'app.db');
  process.env.REVIEW_API_SECRET = 'review-bearer-secret';
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
  process.env.GITHUB_WEBHOOK_SECRET = 'webhook-test-secret';

  const queue = {
    enqueue: async () => ({ accepted: true, jobId: 'job', reason: 'enqueued' as const }),
  } as unknown as ReviewQueue;
  const { webhookRoutes } = await import('./webhook.js');
  const app = webhookRoutes(queue);

  const wrong = await app.request('/review', {
    method: 'POST',
    headers: {
      authorization: 'Bearer wrong-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ owner: 'acme', repo: 'api', pr: 1 }),
  });
  assert.equal(wrong.status, 401);

  const missingBearer = await app.request('/review', {
    method: 'POST',
    headers: {
      authorization: 'Token review-bearer-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ owner: 'acme', repo: 'api', pr: 1 }),
  });
  assert.equal(missingBearer.status, 401);
});

function sign(body: string): string {
  return `sha256=${createHmac('sha256', 'webhook-test-secret').update(body).digest('hex')}`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
