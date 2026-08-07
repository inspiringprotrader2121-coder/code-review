import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildCodexPrompt,
  capCodexDiffFiles,
  clearCodexAuthModeCache,
  CountingSemaphore,
  codexAllowedRepos,
  detectCodexAuthMode,
  isCodexRepoAllowed,
  resolveCodexHomeConcurrency,
  trimCodexPrompt,
} from './codex-cli.js';

function withRepos(value: string | undefined, fn: () => void) {
  const prev = process.env.ORVEX_CODEX_CLI_REPOS;
  if (value === undefined) delete process.env.ORVEX_CODEX_CLI_REPOS;
  else process.env.ORVEX_CODEX_CLI_REPOS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ORVEX_CODEX_CLI_REPOS;
    else process.env.ORVEX_CODEX_CLI_REPOS = prev;
  }
}

test('allowlist empty/unset → nothing is allowed (fail closed)', () => {
  withRepos(undefined, () => {
    assert.equal(isCodexRepoAllowed('acme/widgets'), false);
    assert.deepEqual(codexAllowedRepos(), []);
  });
  withRepos('', () => {
    assert.equal(isCodexRepoAllowed('acme/widgets'), false);
  });
});

test('allowlisted repo passes, others refused', () => {
  withRepos('Acme/Widgets, acme/api ,', () => {
    assert.equal(isCodexRepoAllowed('acme/widgets'), true); // case-insensitive
    assert.equal(isCodexRepoAllowed('acme/api'), true);
    assert.equal(isCodexRepoAllowed('evil/malware'), false);
  });
});

test('missing repoId is refused even with a populated allowlist', () => {
  withRepos('acme/widgets', () => {
    assert.equal(isCodexRepoAllowed(undefined), false);
  });
});

test('"*" opts out of the check (documented escape hatch)', () => {
  withRepos('*', () => {
    assert.equal(isCodexRepoAllowed('anything/at-all'), true);
  });
});

test('capCodexDiffFiles truncates then stubs remaining files', () => {
  const files = [
    { filename: 'a.ts', status: 'modified', patch: 'AAAA' },
    { filename: 'b.ts', status: 'modified', patch: 'BBBBBBBB' },
    { filename: 'c.ts', status: 'modified', patch: 'CCCC' },
  ];
  const capped = capCodexDiffFiles(files, 10);
  assert.equal(capped[0]!.patch, 'AAAA');
  assert.match(capped[1]!.patch ?? '', /truncated|checkout/);
  assert.match(capped[2]!.patch ?? '', /omitted|checkout/);
});

test('lean Codex prompt omits changedContents when checkout exists', (t) => {
  t.after(() => {
    delete process.env.ORVEX_CODEX_MAX_DIFF_CHARS;
    delete process.env.ORVEX_CODEX_MAX_PROMPT_CHARS;
    delete process.env.ORVEX_CODEX_MAX_TREE_PATHS;
  });
  process.env.ORVEX_CODEX_MAX_DIFF_CHARS = '5000';
  process.env.ORVEX_CODEX_MAX_PROMPT_CHARS = '200000';
  process.env.ORVEX_CODEX_MAX_TREE_PATHS = '50';

  const files = [
    {
      filename: 'src/a.ts',
      status: 'modified',
      patch: '+const x = 1;\n',
    },
  ];
  const secretMarker = 'UNIQUE_CHANGED_BODY_SHOULD_NOT_APPEAR_IN_LEAN';
  const lean = buildCodexPrompt(
    files,
    {
      changedContents: [{ path: 'src/a.ts', content: secretMarker + '\n'.repeat(20) }],
      related: [{ path: 'src/b.ts', content: 'RELATED_SHOULD_NOT_APPEAR' }],
      treePaths: Array.from({ length: 80 }, (_, i) => `f${i}.ts`),
      extraFocus: 'FOCUS_LENS',
    },
    { hasRepoCheckout: true, mode: 'lean' },
  );
  assert.equal(lean.includes(secretMarker), false);
  assert.equal(lean.includes('RELATED_SHOULD_NOT_APPEAR'), false);
  assert.match(lean, /INVESTIGATE the repo/);
  assert.match(lean, /NEVER dump a whole large file/);
  assert.match(lean, /src\/a\.ts/);
  assert.match(lean, /FOCUS_LENS/);
  // Tree capped to 50 paths
  assert.equal(lean.includes('f49.ts'), true);
  assert.equal(lean.includes('f79.ts'), false);
});

test('slim Codex prompt is shorter and skips rules/tree dump', () => {
  const files = [
    { filename: 'x.ts', status: 'modified', patch: '+y\n' },
  ];
  const slim = buildCodexPrompt(
    files,
    {
      changedContents: [{ path: 'x.ts', content: 'FULL_FILE_BODY' }],
      treePaths: ['a.ts', 'b.ts'],
    },
    { hasRepoCheckout: true, mode: 'slim' },
  );
  assert.equal(slim.includes('FULL_FILE_BODY'), false);
  assert.match(slim, /slim context/);
  assert.equal(slim.includes('Repository structure'), false);
});

test('trimCodexPrompt enforces a hard ceiling', () => {
  const long = 'x'.repeat(500);
  const trimmed = trimCodexPrompt(long, 200);
  assert.ok(trimmed.length < long.length);
  assert.match(trimmed, /truncated/);
  assert.equal(trimCodexPrompt('short', 100), 'short');
});

test('detectCodexAuthMode reads auth_mode from CODEX_HOME', () => {
  clearCodexAuthModeCache();
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-codex-auth-'));
  try {
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }));
    assert.equal(detectCodexAuthMode(dir), 'apikey');
    clearCodexAuthModeCache();
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh: 'x' } }));
    assert.equal(detectCodexAuthMode(dir), 'oauth');
    clearCodexAuthModeCache();
    writeFileSync(path.join(dir, 'auth.json'), '{');
    assert.equal(detectCodexAuthMode(dir), 'unknown');
  } finally {
    clearCodexAuthModeCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCodexHomeConcurrency: oauth always 1; apikey uses env / max reviews', (t) => {
  t.after(() => {
    delete process.env.ORVEX_CODEX_APIKEY_CONCURRENCY;
    delete process.env.ORVEX_MAX_CONCURRENT_REVIEWS;
  });
  assert.equal(resolveCodexHomeConcurrency('oauth'), 1);
  assert.equal(resolveCodexHomeConcurrency('unknown'), 1);

  delete process.env.ORVEX_CODEX_APIKEY_CONCURRENCY;
  process.env.ORVEX_MAX_CONCURRENT_REVIEWS = '8';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 8);

  process.env.ORVEX_CODEX_APIKEY_CONCURRENCY = '3';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 3);

  process.env.ORVEX_CODEX_APIKEY_CONCURRENCY = '99';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 32); // hard cap
});

test('CountingSemaphore allows up to N concurrent runners', async () => {
  const gate = new CountingSemaphore(2);
  let concurrent = 0;
  let peak = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const tasks = Array.from({ length: 5 }, () =>
    gate.run(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await sleep(30);
      concurrent--;
    }),
  );
  await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.equal(gate.inFlight, 0);
});
