import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from './redact.js';

test('redacts unquoted KEY=value (the common .env / CI leak)', () => {
  const out = redactSecrets('API_KEY=AbCdEf0123456789xyz');
  assert.doesNotMatch(out, /AbCdEf0123456789xyz/);
  assert.match(out, /\[REDACTED\]/);
});

test('redacts Anthropic sk-ant- keys (old regex stopped at the hyphen)', () => {
  const out = redactSecrets('const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";');
  assert.doesNotMatch(out, /abcdefghijklmnopqrstuvwxyz/);
});

test('redacts Stripe, Google, Slack keys and PEM blocks', () => {
  assert.doesNotMatch(redactSecrets('sk_live_abcdefghij0123456789'), /abcdefghij0123456789/);
  assert.doesNotMatch(redactSecrets('AIzaSyA1234567890abcdefghijklmnopqrstuvw'), /SyA1234567890/);
  assert.doesNotMatch(redactSecrets('xoxb-1234567890-abcdefghijkl'), /abcdefghijkl/);
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\nline2\n-----END RSA PRIVATE KEY-----';
  const out = redactSecrets(pem);
  assert.doesNotMatch(out, /MIIEabc123/);
  assert.match(out, /PRIVATE_KEY_REDACTED/);
});

test('still redacts the originally-covered shapes (ghp_, JWT, AWS)', () => {
  assert.doesNotMatch(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123'), /abcdefghijklmnop/);
  assert.doesNotMatch(redactSecrets('AKIAIOSFODNN7EXAMPLE'), /IOSFODNN7EXAMPLE/);
});

test('does NOT redact ordinary prose or short values', () => {
  const prose = 'The token is passed to the next function for validation.';
  assert.equal(redactSecrets(prose), prose, 'no assignment + short words → untouched');
});
