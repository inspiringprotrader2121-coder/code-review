import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildCodexPrompt,
  capCodexDiffFiles,
  clearCodexAuthModeCache,
  codexAnnouncedModelFallback,
  CountingSemaphore,
  codexAllowedRepos,
  DEFAULT_CODEX_CLI_MODEL,
  detectCodexAuthMode,
  isCodexRepoAllowed,
  resolveCodexBinary,
  resolveCodexHomeConcurrency,
  resolveCodexRateLimitPolicy,
  resolveCodexTimeouts,
  runCodexCliReview,
  runCodexExecForTest,
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

test('Codex model and binary are pinned locally before any stale global path', () => {
  assert.equal(DEFAULT_CODEX_CLI_MODEL, 'gpt-5.6-luna');
  const root = '/srv/orvex';
  const local = path.join(root, 'node_modules', '.bin', 'codex');
  assert.equal(resolveCodexBinary(root, '/old/global/codex', (candidate) => candidate === local), local);
  assert.throws(
    () => resolveCodexBinary(root, '/global/codex', () => false),
    /pinned Codex CLI is missing/,
  );
});

test('Codex CLI model substitutions are detected and fail closed', () => {
  assert.equal(
    codexAnnouncedModelFallback(
      'gpt-5.6-luna not supported, falling back to gpt-5.5 max',
    ),
    true,
  );
  assert.equal(
    codexAnnouncedModelFallback(
      'Model gpt-5.6-luna is not supported by this client; falling back to model gpt-5.5',
    ),
    true,
  );
  assert.equal(
    codexAnnouncedModelFallback('network transport unavailable; falling back to polling'),
    false,
  );
});

test('resolveCodexHomeConcurrency: every auth mode is locked to one', (t) => {
  t.after(() => {
    delete process.env.ORVEX_CODEX_APIKEY_CONCURRENCY;
    delete process.env.ORVEX_MAX_CONCURRENT_REVIEWS;
  });
  assert.equal(resolveCodexHomeConcurrency('oauth'), 1);
  assert.equal(resolveCodexHomeConcurrency('unknown'), 1);

  delete process.env.ORVEX_CODEX_APIKEY_CONCURRENCY;
  process.env.ORVEX_MAX_CONCURRENT_REVIEWS = '8';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 1);

  process.env.ORVEX_CODEX_APIKEY_CONCURRENCY = '3';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 1);

  process.env.ORVEX_CODEX_APIKEY_CONCURRENCY = '99';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 1);
});

test('resolveCodexTimeouts bounds wall and silence timers', () => {
  assert.deepEqual(resolveCodexTimeouts({}), { hardMs: 480_000, inactivityMs: 180_000 });
  assert.deepEqual(
    resolveCodexTimeouts({
      ORVEX_CODEX_TIMEOUT_MS: '120000',
      ORVEX_CODEX_INACTIVITY_TIMEOUT_MS: '999999',
    }),
    { hardMs: 120_000, inactivityMs: 120_000 },
  );
  assert.deepEqual(
    resolveCodexTimeouts({
      ORVEX_CODEX_TIMEOUT_MS: '9999999',
      ORVEX_CODEX_INACTIVITY_TIMEOUT_MS: '1',
    }),
    { hardMs: 900_000, inactivityMs: 30_000 },
  );
});

test('Codex rate-limit recovery permits at most one bounded retry', () => {
  assert.deepEqual(resolveCodexRateLimitPolicy({}), {
    maxAttempts: 2,
    maxWaitMs: 60_000,
    totalWaitBudgetMs: 60_000,
  });
  assert.deepEqual(
    resolveCodexRateLimitPolicy({
      ORVEX_RATELIMIT_MAX_RETRIES: '99',
      ORVEX_CODEX_RATELIMIT_MAX_WAIT_MS: '999999',
      ORVEX_CODEX_RATELIMIT_TOTAL_WAIT_MS: '999999',
    }),
    { maxAttempts: 2, maxWaitMs: 60_000, totalWaitBudgetMs: 60_000 },
  );
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

test('CountingSemaphore removes a cancelled waiter before it can spawn paid work', async () => {
  const gate = new CountingSemaphore(1);
  let release!: () => void;
  const held = gate.run(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const controller = new AbortController();
  let entered = false;
  const waiting = gate.run(async () => {
    entered = true;
  }, controller.signal);

  controller.abort();
  await assert.rejects(waiting, /cancelled/i);
  assert.equal(entered, false);
  release();
  await held;
  assert.equal(gate.inFlight, 0);
});

test('a pre-cancelled Codex review fails before spawning the CLI', async () => {
  const controller = new AbortController();
  controller.abort('pr_closed_mid_run');
  await assert.rejects(
    runCodexCliReview(
      [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
      { signal: controller.signal },
    ),
    /cancelled/i,
  );
});

function fakeCodex(source: string): { dir: string; binary: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-fake-codex-'));
  const binary = path.join(dir, 'codex');
  writeFileSync(binary, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(binary, 0o755);
  return { dir, binary };
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('actual Codex child receives pinned model/reasoning arguments and returns output', async (t) => {
  const fixture = fakeCodex(`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(args));
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(output, '{"findings":[],"summary":"ok"}');
console.log(JSON.stringify({type:'thread.started', thread_id:'fixture-thread'}));
console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:12, output_tokens:3, reasoning_output_tokens:2}}));
`);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const argsFile = path.join(fixture.dir, 'args.json');
  const result = await runCodexExecForTest('review this', {
    binaryPath: fixture.binary,
    env: { ...process.env, ARGS_FILE: argsFile },
  });
  assert.equal(result.threadId, 'fixture-thread');
  const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
  assert.deepEqual(args.slice(0, 3), ['exec', '--model', DEFAULT_CODEX_CLI_MODEL]);
  assert.ok(args.includes('model_reasoning_effort="max"'));
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('actual Codex child model substitution on stdout fails closed', async (t) => {
  const fixture = fakeCodex(`
console.log('gpt-5.6-luna not supported, falling back to gpt-5.5 max');
setInterval(() => {}, 1000);
`);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  await assert.rejects(
    runCodexExecForTest('review', { binaryPath: fixture.binary, hardMs: 1_000, inactivityMs: 500 }),
    /refused model substitution/,
  );
});

test('actual silent Codex child is killed by negative process-group id, including grandchildren', async (t) => {
  const fixture = fakeCodex(`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
fs.writeFileSync(process.env.GRANDCHILD_FILE, String(child.pid));
setInterval(() => {}, 1000);
`);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const grandchildFile = path.join(fixture.dir, 'grandchild.pid');
  await assert.rejects(
    runCodexExecForTest('review', {
      binaryPath: fixture.binary,
      hardMs: 2_000,
      inactivityMs: 500,
      env: { ...process.env, GRANDCHILD_FILE: grandchildFile },
    }),
    /produced no output/,
  );
  const grandchildPid = Number(readFileSync(grandchildFile, 'utf8'));
  assert.equal(await waitForExit(grandchildPid), true, 'grandchild process group member was killed');
});

test('hard timeout settles despite delayed close and removes the temporary output directory', async (t) => {
  const fixture = fakeCodex(`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(process.env.TMPDIR_FILE, path.dirname(output));
fs.writeFileSync(output, '{"findings":[],"summary":"ok"}');
console.log(JSON.stringify({type:'thread.started', thread_id:'fixture-thread'}));
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {stdio:['ignore', 1, 2]});
`);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const tempDirFile = path.join(fixture.dir, 'tempdir.txt');
  await assert.rejects(
    runCodexExecForTest('review', {
      binaryPath: fixture.binary,
      hardMs: 750,
      inactivityMs: 2_000,
      env: { ...process.env, TMPDIR_FILE: tempDirFile },
    }),
    /wall-clock cap/,
  );
  const codexTempDir = readFileSync(tempDirFile, 'utf8');
  assert.equal(existsSync(codexTempDir), false, 'timeout cleanup removed the temp directory before delayed close');
});
