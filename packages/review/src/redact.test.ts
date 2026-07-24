import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from './redact.js';

test('redacts unquoted KEY=value (the common .env / CI leak)', () => {
  const out = redactSecrets('API_KEY=AbCdEf0123456789xyz');
  assert.doesNotMatch(out, /AbCdEf0123456789xyz/);
  assert.match(out, /\[REDACTED\]/);
});

test('P1 regression: PREFIXED SCREAMING_SNAKE env secrets are redacted (the \\b bug)', () => {
  // The leading \b never matched these because `_` is a word char — they shipped
  // the value to the LLM. Each must now be redacted.
  for (const [line, secret] of [
    ['JWT_SECRET=supersecretvalue123', 'supersecretvalue123'],
    ['DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['AWS_SECRET_ACCESS_KEY=AKIAexampleKeyMaterialXyz', 'exampleKeyMaterialXyz'],
    ['SESSION_SECRET=abcd1234efgh5678', 'abcd1234efgh5678'],
    ['GITHUB_TOKEN=ghtok_abcdef123456', 'ghtok_abcdef123456'],
  ] as const) {
    const out = redactSecrets(line);
    assert.doesNotMatch(out, new RegExp(secret), `leaked: ${line}`);
    assert.match(out, /\[REDACTED\]/, `not redacted: ${line}`);
  }
});

test('redacts connection-string passwords and Slack webhook URLs', () => {
  const db = redactSecrets('DATABASE_URL=postgres://admin:s3cretP4ss@db.host:5432/app');
  assert.doesNotMatch(db, /s3cretP4ss/);
  const slack = redactSecrets('https://hooks.slack.com/services/T00000000/B11111111/aBcDeFgHiJkLmNoP');
  assert.doesNotMatch(slack, /aBcDeFgHiJkLmNoP/);
});

test('P1 regression: userless connection strings (redis AUTH) are redacted', () => {
  for (const [line, secret] of [
    ['redis://:mypassword123@redis:6379', 'mypassword123'],
    ['mongodb://:pw12345678@host/db', 'pw12345678'],
    ['REDIS_URL=redis://:s3cretpass@h:6379', 's3cretpass'],
  ] as const) {
    assert.doesNotMatch(redactSecrets(line), new RegExp(secret), `leaked: ${line}`);
  }
});

test('P1 regression: SCREAMING_SNAKE secrets where keyword is not the last token', () => {
  for (const [line, secret] of [
    ['SECRET_KEY=django-insecure-abcxyz', 'django-insecure-abcxyz'],
    ['SECRET_KEY_BASE=railsbase64secret', 'railsbase64secret'],
    ['PRIVATE_KEY=MIIEabc123base64val', 'MIIEabc123base64val'],
    ['ENCRYPTION_KEY=aeskeymaterial12', 'aeskeymaterial12'],
    ['SIGNING_KEY=sigval123456', 'sigval123456'],
    ['MASTER_KEY=masterval1234', 'masterval1234'],
    ['GPG_PASSPHRASE=phrase1234', 'phrase1234'],
  ] as const) {
    assert.doesNotMatch(redactSecrets(line), new RegExp(secret), `leaked: ${line}`);
  }
});

test('redacts Authorization: Bearer tokens', () => {
  const out = redactSecrets('Authorization: Bearer abcdef1234567890xyztoken');
  assert.doesNotMatch(out, /abcdef1234567890xyztoken/);
});

test('does not over-redact ordinary prose containing key/secret/token words', () => {
  for (const p of ['this is the key insight', 'the secret to success', 'a token of appreciation']) {
    assert.equal(redactSecrets(p), p, `over-redacted: ${p}`);
  }
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

test('infra/config credential shapes are redacted (retrieval now pulls these files)', () => {
  const leaks: Array<[string, string]> = [
    ['rails secrets.yml', 'secret_key_base: 3f7a9c2e8b1d4f6a0c5e7b9d2f4a6c8e'],
    ['terraform tfvars', 'db_pw  = "Tr0ub4dor3xkcd"'],
    ['k8s long-form env', '- name: DATABASE_PASSWORD\n  value: pgS3cretValue'],
    ['k8s base64 PEM', 'tls.key: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2Z0lCQURBTkJna3Foa2lH'],
    ['nginx directive', 'proxy_set_header X-Internal-Token 8f3a9c2e8b1d4f6a0c5e7b9d;'],
    ['java properties', 'ldap.bind.pwd=SuperSecret123'],
    ['redis auth', 'redis.auth=abc123def456'],
    ['sentry dsn', 'SENTRY_DSN=https://9f8e7d6c5b4a3f2e1d0c9b8a@o12345.ingest.sentry.io/1234'],
  ];
  for (const [label, raw] of leaks) {
    assert.match(redactSecrets(raw), /REDACTED/, `${label} must be redacted before reaching an LLM`);
  }
});

test('redaction does not eat ordinary code or config', () => {
  for (const clean of [
    'const apiUrl = buildUrl(base)',
    'replicas: 3',
    'export function computePwStrength(input) { return score(input) }',
    'import { getToken } from "./auth"',
  ]) {
    assert.equal(redactSecrets(clean), clean, `must not over-redact: ${clean}`);
  }
});
