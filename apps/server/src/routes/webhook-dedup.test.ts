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
});

function sign(body: string): string {
  return `sha256=${createHmac('sha256', 'webhook-test-secret').update(body).digest('hex')}`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
