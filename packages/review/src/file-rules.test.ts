import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileRulesFor, loadOrvexRules, buildUserPrompt } from './prompt.js';

test('file-type rules are injected only for matching changed files', () => {
  assert.equal(
    fileRulesFor(['src/app.ts']).includes('module system'),
    true,
    'TS gets the JS/TS doc',
  );
  assert.equal(
    fileRulesFor(['src/app.ts']).includes('Service parity'),
    false,
    'TS must NOT pay for infra rules',
  );

  const infra = fileRulesFor(['docker-compose.yml']);
  assert.match(infra, /Service parity/, 'compose gets infra rules');
  assert.match(infra, /Proxy \/ trust headers/);

  assert.match(fileRulesFor(['k8s/backend-deployment.yaml']), /Service parity/);
  assert.match(fileRulesFor(['frontend/nginx.conf']), /Proxy \/ trust headers/);
  assert.match(fileRulesFor(['infra/main.tf']), /Widened exposure/);
  assert.match(fileRulesFor(['.github/workflows/ci.yml']), /pull_request_target/);
  assert.match(fileRulesFor(['prisma/migrations/001_init/migration.sql']), /SHAPE-CONSISTENT/);
});

test('a plain code change pays nothing for infra/CI rules', () => {
  assert.equal(fileRulesFor(['README.md']), '', 'no match → no extra tokens');
  const jsOnly = fileRulesFor(['src/a.ts', 'src/b.tsx']);
  assert.doesNotMatch(jsOnly, /pull_request_target/);
  assert.doesNotMatch(jsOnly, /Service parity/);
});

test('each doc is included at most once across many matching files', () => {
  const many = fileRulesFor(['k8s/a.yaml', 'k8s/b.yaml', 'docker-compose.yml', 'infra/x.tf']);
  assert.equal(many.split('Service parity').length - 1, 1, 'infra doc appears exactly once');
});

test('the universal core keeps its hard-won calibration rules', () => {
  // Normalize wrapping — these rules are prose and wrap across lines.
  const core = loadOrvexRules().replace(/\s+/g, ' ');
  // Each of these encodes a distinct severity failure mode learned from a real
  // benchmark loss — consolidating the wording must never drop one.
  for (const rule of [
    'illusory guard',
    'Wrong field for a decision',
    'Unvalidated external input that reaches a SIDE EFFECT',
    'leaked external resource',
    'Never argue a bug down',
    'pre-existing',
    'validated downstream',
    'not user-facing',
  ]) {
    assert.match(
      core,
      new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `core must retain: ${rule}`,
    );
  }
  assert.match(core, /## Scope/, 'scope discipline must be present');
});

test('file rules land inside the cacheable prefix, before the per-pass lens', () => {
  const body = buildUserPrompt(
    [{ filename: 'docker-compose.yml', status: 'modified', patch: '@@ -1 +1 @@\n+x' }],
    { extraFocus: 'LENS-SENTINEL' },
  );
  const rulesAt = body.indexOf('Rules for the file types');
  const lensAt = body.indexOf('LENS-SENTINEL');
  assert.ok(rulesAt > 0 && lensAt > rulesAt, 'file rules must precede the varying lens tail');
});
