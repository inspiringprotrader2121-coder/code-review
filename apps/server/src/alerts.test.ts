import assert from 'node:assert/strict';
import test from 'node:test';
import { sendOperationalAlert } from './alerts.js';
import { testServerConfig } from './bootstrap/test-config.js';

test('operational alerts post a bounded payload and deduplicate repeated events', async (t) => {
  const previousUrl = process.env.ORVEX_ALERT_WEBHOOK_URL;
  process.env.ORVEX_ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
  const config = testServerConfig();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.ORVEX_ALERT_WEBHOOK_URL;
    else process.env.ORVEX_ALERT_WEBHOOK_URL = previousUrl;
  });

  assert.equal(
    await sendOperationalAlert(
      { event: 'test-alert', severity: 'critical', message: 'provider unavailable' },
      config.alerts.webhookUrl,
    ),
    true,
  );
  assert.equal(
    await sendOperationalAlert(
      { event: 'test-alert', severity: 'critical', message: 'provider unavailable again' },
      config.alerts.webhookUrl,
    ),
    false,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://alerts.example.test/hook');
  assert.equal(requests[0]?.body.severity, 'critical');
  assert.equal(requests[0]?.body.message, 'provider unavailable');
});

test('failed alert delivery is retryable instead of being deduplicated as sent', async (t) => {
  const previousUrl = process.env.ORVEX_ALERT_WEBHOOK_URL;
  process.env.ORVEX_ALERT_WEBHOOK_URL = 'https://alerts.example.test/retry';
  const config = testServerConfig();
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return attempts === 1 ? new Response('down', { status: 503 }) : Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.ORVEX_ALERT_WEBHOOK_URL;
    else process.env.ORVEX_ALERT_WEBHOOK_URL = previousUrl;
  });

  const input = {
    event: 'retry-alert',
    severity: 'warning' as const,
    message: 'temporary failure',
  };
  assert.equal(await sendOperationalAlert(input, config.alerts.webhookUrl), false);
  assert.equal(await sendOperationalAlert(input, config.alerts.webhookUrl), true);
  assert.equal(attempts, 2);
});
