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

test('redaction is linear-time on adversarial input (no ReDoS worker stall)', () => {
  // An unanchored greedy prefix made this quadratic: 50kB of hex blocked the
  // single-threaded worker for 6.3s, fully controlled by PR content.
  for (const size of [50_000, 100_000]) {
    const started = Date.now();
    redactSecrets('deadbeef'.repeat(size / 8));
    const ms = Date.now() - started;
    assert.ok(ms < 1_000, `${size}B took ${ms}ms — redaction must stay linear`);
  }
});

test('redaction never corrupts reviewable source code', () => {
  // Rewriting `const passwordOk = verifyPassword(password, hash)` to
  // `= [REDACTED],` blinded the reviewer to the auth logic it exists to audit
  // AND handed the model syntactically invalid code.
  for (const line of [
    'const passwordOk = verifyPassword(password, storedHash ?? DUMMY_PASSWORD_HASH);',
    "fetch(url, {credentials: 'same-origin'})",
    'const passwordHash = bcrypt.hashSync(password,10);',
    'export function hashPassword(password: string): string {',
    'export function encryptTotpSecret(secret: string, masterSecret: string): string {',
    'interface Opts { apiKey: string; webhookSecret: string; }',
  ]) {
    assert.equal(redactSecrets(line), line, `must not corrupt source: ${line}`);
  }
});

test('k8s env secrets are redacted inside DIFFS, not just whole files', () => {
  // Patches are the primary payload of every review; the first draft's
  // whitespace class did not tolerate the `+` prefix.
  const diff = '+        - name: DB_PASSWORD\n+          value: Sup3rS3cretInDiff';
  const out = redactSecrets(diff);
  assert.match(out, /REDACTED/);
  assert.doesNotMatch(out, /Sup3rS3cretInDiff/, 'the secret itself must not survive');
});

test('base64 PEM redaction does not swallow neighbouring keys', () => {
  const manifest = 'kind: Secret\ndata:\n  tls.key: LS0tLS1CRUdJTiBQUklWQVRF\n  replicas: 3\n  imageTag: v1.2.3';
  const out = redactSecrets(manifest);
  assert.match(out, /replicas: 3/, 'following lines must survive');
  assert.match(out, /imageTag: v1\.2\.3/);
});

test('a PEM key TRUNCATED by context clipping is still redacted', () => {
  // Context files are clipped to a byte budget BEFORE redaction runs, so a key
  // straddling the cut lost its `-----END-----`, failed the block match, and
  // shipped its header + first base64 lines to a third-party model in clear.
  const key =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0ZxSECRETKEYMATERIAL\nMORESECRET2\n-----END RSA PRIVATE KEY-----';
  assert.match(redactSecrets(key), /PRIVATE_KEY_REDACTED/, 'whole key');
  const truncated = key.slice(0, 90);
  assert.match(redactSecrets(truncated), /PRIVATE_KEY_REDACTED/, 'truncated key');
  assert.doesNotMatch(redactSecrets(truncated), /SECRETKEYMATERIAL/, 'no key material may survive');
  // PGP armor says "PRIVATE KEY BLOCK", which the old pattern did not match.
  assert.match(
    redactSecrets('-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGF3x\n-----END PGP PRIVATE KEY BLOCK-----'),
    /PRIVATE_KEY_REDACTED/,
  );
});

test('JSON/dict-quoted secrets are redacted (the quote defeated every other rule)', () => {
  for (const [label, raw, secret] of [
    ['settings.json', '{"password": "Sup3rS3cretJson"}', 'Sup3rS3cretJson'],
    ['oauth config', '{"client_secret": "abc123def456"}', 'abc123def456'],
    ['bare pair', '"apiKey": "live_abc123def"', 'live_abc123def'],
  ] as const) {
    const out = redactSecrets(raw);
    assert.match(out, /REDACTED/, `${label} must be redacted`);
    assert.doesNotMatch(out, new RegExp(secret), `${label}: the secret itself must not survive`);
  }
});

test('quoted-key redaction does not touch ordinary JSON', () => {
  for (const clean of ['{"name": "my-service"}', '{"tokenCount": 42}', '{"replicas": 3}']) {
    assert.equal(redactSecrets(clean), clean);
  }
});

test('redaction stays linear on identifier-run input (ReDoS guard)', () => {
  // Unbounded quantifiers straddling the keyword alternation backtracked
  // quadratically on a run like 'a-b_a-b_…' — measured 9.7s at 80kB of BLOCKED
  // event loop, from attacker-controlled PR file content.
  for (const size of [80_000, 200_000]) {
    const started = Date.now();
    redactSecrets('a-b_'.repeat(size / 4));
    const ms = Date.now() - started;
    assert.ok(ms < 500, `${size}B took ${ms}ms — redaction must stay linear`);
  }
});
