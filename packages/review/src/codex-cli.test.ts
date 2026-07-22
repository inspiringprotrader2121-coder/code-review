import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexAllowedRepos, isCodexRepoAllowed } from './codex-cli.js';

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
