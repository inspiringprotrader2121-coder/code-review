import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from './webhook.js';
import type { GitHubAppConfig } from './types.js';

function cfg(webhookSecret: string): GitHubAppConfig {
  return { appId: '1', privateKey: 'k', webhookSecret, botLogin: 'bot[bot]' };
}

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

test('a correctly-signed payload verifies', () => {
  const body = '{"action":"opened"}';
  assert.equal(verifyWebhookSignature(cfg('s3cret'), body, sign('s3cret', body)), true);
});

test('a wrong/forged signature is rejected', () => {
  const body = '{"action":"opened"}';
  assert.equal(verifyWebhookSignature(cfg('s3cret'), body, sign('wrong', body)), false);
  assert.equal(verifyWebhookSignature(cfg('s3cret'), body, 'sha256=deadbeef'), false);
  assert.equal(verifyWebhookSignature(cfg('s3cret'), body, undefined), false);
});

test('FAIL CLOSED: no secret configured → reject by default (was: accept)', () => {
  delete process.env.ORVEX_ALLOW_UNSIGNED_WEBHOOKS;
  assert.equal(verifyWebhookSignature(cfg(''), '{}', 'sha256=whatever'), false);
});

test('unsigned is accepted ONLY with the explicit dev override', () => {
  process.env.ORVEX_ALLOW_UNSIGNED_WEBHOOKS = '1';
  assert.equal(verifyWebhookSignature(cfg(''), '{}', undefined), true);
  delete process.env.ORVEX_ALLOW_UNSIGNED_WEBHOOKS;
});
