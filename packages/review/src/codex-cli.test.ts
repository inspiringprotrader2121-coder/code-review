import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildCodexPrompt,
  buildCodexExecArgs,
  assertCodexRuntimeReady,
  capCodexDiffFiles,
  clearCodexAuthModeCache,
  codexAnnouncedModelFallback,
  CountingSemaphore,
  codexAllowedRepos,
  DEFAULT_CODEX_CLI_MODEL,
  detectCodexAuthMode,
  isCodexRepoAllowed,
  normalizeCodexAttemptError,
  resolveCodexBinary,
  resolveCodexHomeConcurrency,
  resolveCodexRateLimitPolicy,
  resolveCodexTimeouts,
  runCodexCliReview,
  runCodexContainerExecForTest,
  runCodexExecForTest,
  trimCodexPrompt,
  withCodexHomeLockForTest,
} from './codex-cli.js';
import type { CodexContainerRequest, CodexContainerRuntime } from './providers/types.js';

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

test('"*" is refused until Codex has a credential-isolating runner', () => {
  withRepos('*', () => {
    assert.equal(isCodexRepoAllowed('anything/at-all'), false);
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
  assert.match(lean, /at most 12 shell\/tool calls/);
  assert.match(lean, /src\/a\.ts/);
  assert.match(lean, /FOCUS_LENS/);
  // Tree capped to 50 paths
  assert.equal(lean.includes('f49.ts'), true);
  assert.equal(lean.includes('f79.ts'), false);
});

test('slim Codex prompt is shorter and skips rules/tree dump', () => {
  const files = [{ filename: 'x.ts', status: 'modified', patch: '+y\n' }];
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
  assert.match(slim, /at most 8 shell\/tool calls/);
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
    writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }),
    );
    assert.equal(detectCodexAuthMode(dir), 'apikey');
    clearCodexAuthModeCache();
    writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh: 'x' } }),
    );
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
  const pinned = '/srv/orvex/node_modules/@openai/codex/bin/codex.js';
  assert.equal(
    resolveCodexBinary(
      '/old/global/codex',
      () => pinned,
      (candidate) => candidate === pinned,
    ),
    pinned,
  );
  assert.throws(
    () =>
      resolveCodexBinary(
        '/global/codex',
        () => {
          throw new Error('missing');
        },
        () => false,
      ),
    /pinned Codex CLI .*is missing/,
  );
});

test('Codex binary resolution works from the production apps/server cwd', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const moduleUrl = pathToFileURL(path.join(root, 'packages/review/src/codex-cli.ts')).href;
  const script = `import { resolveCodexBinary } from ${JSON.stringify(moduleUrl)}; console.log(resolveCodexBinary());`;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: path.join(root, 'apps/server'),
      env: { ...process.env, ORVEX_CODEX_CLI_PATH: '/tmp/unpinned-codex' },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout.trim(), /@openai[+/]codex@0\.147\.0.*\/bin\/codex\.js$/);
  assert.doesNotMatch(child.stdout, /apps\/server\/node_modules\/\.bin/);
});

test('Codex runtime preflight requires an API-key-authenticated home', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-codex-preflight-'));
  try {
    writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }),
    );
    clearCodexAuthModeCache();
    assert.match(assertCodexRuntimeReady([dir]), /@openai.*codex.*bin\/codex\.js/);

    writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh: 'x' } }),
    );
    clearCodexAuthModeCache();
    assert.throws(() => assertCodexRuntimeReady([dir]), /API-key-authenticated/);
  } finally {
    clearCodexAuthModeCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex CLI model substitutions are detected and fail closed', () => {
  assert.equal(
    codexAnnouncedModelFallback('gpt-5.6-luna not supported, falling back to gpt-5.5 max'),
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

test('Codex execution arguments require the native read-only sandbox', () => {
  const args = buildCodexExecArgs({
    model: DEFAULT_CODEX_CLI_MODEL,
    reasoningEffort: 'max',
    cwd: '/tmp/review-checkout',
    lastMessageFile: '/tmp/last-message.txt',
  });

  assert.deepEqual(args.slice(0, 4), ['exec', '--model', DEFAULT_CODEX_CLI_MODEL, '--json']);
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), [
    '--sandbox',
    'read-only',
  ]);
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.ok(args.includes('model_reasoning_effort="max"'));
  assert.ok(
    args.includes(
      'shell_environment_policy.exclude=["CODEX_HOME","OPENAI_API_KEY","CODEX_API_KEY","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY"]',
    ),
  );
  assert.ok(args.includes('--cd'));
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(args.includes('--ephemeral'), false, 'sessions must remain resumable');
});

test('Codex resume arguments preserve the session and do not reset its checkout', () => {
  const args = buildCodexExecArgs({
    model: DEFAULT_CODEX_CLI_MODEL,
    reasoningEffort: 'max',
    threadId: 'existing-thread',
    cwd: '/tmp/ignored-on-resume',
    lastMessageFile: '/tmp/last-message.txt',
  });

  assert.equal(args.includes('--cd'), false);
  assert.deepEqual(args.slice(-3), ['resume', 'existing-thread', '-']);
  assert.ok(args.includes('--sandbox'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});

test('resolveCodexHomeConcurrency: API-key homes honor bounded parallel capacity', (t) => {
  const previousApiKeyConcurrency = process.env.ORVEX_CODEX_APIKEY_CONCURRENCY;
  const previousReviewConcurrency = process.env.ORVEX_MAX_CONCURRENT_REVIEWS;
  t.after(() => {
    if (previousApiKeyConcurrency === undefined) delete process.env.ORVEX_CODEX_APIKEY_CONCURRENCY;
    else process.env.ORVEX_CODEX_APIKEY_CONCURRENCY = previousApiKeyConcurrency;
    if (previousReviewConcurrency === undefined) delete process.env.ORVEX_MAX_CONCURRENT_REVIEWS;
    else process.env.ORVEX_MAX_CONCURRENT_REVIEWS = previousReviewConcurrency;
  });
  assert.equal(resolveCodexHomeConcurrency('oauth'), 1);
  assert.equal(resolveCodexHomeConcurrency('unknown'), 1);

  delete process.env.ORVEX_CODEX_APIKEY_CONCURRENCY;
  process.env.ORVEX_MAX_CONCURRENT_REVIEWS = '8';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 8);

  process.env.ORVEX_CODEX_APIKEY_CONCURRENCY = '3';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 3);

  process.env.ORVEX_CODEX_APIKEY_CONCURRENCY = '99';
  assert.equal(resolveCodexHomeConcurrency('apikey'), 32);
});

test('production home lock admits eight API-key calls and holds the ninth', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  let markEightEntered!: () => void;
  const eightEntered = new Promise<void>((resolve) => {
    markEightEntered = resolve;
  });
  let ninthEntered = false;

  await withCodexHomeLockForTest(
    { mode: 'apikey', env: { ORVEX_CODEX_APIKEY_CONCURRENCY: '8' } },
    async (withLock) => {
      const firstEight = Array.from({ length: 8 }, () =>
        withLock(async () => {
          entered++;
          if (entered === 8) markEightEntered();
          await blocked;
        }),
      );
      await eightEntered;

      const ninth = withLock(async () => {
        ninthEntered = true;
      });
      await Promise.resolve();
      assert.equal(ninthEntered, false, 'ninth API-key call must wait for a home slot');

      release();
      await Promise.all([...firstEight, ninth]);
      assert.equal(ninthEntered, true);
    },
  );
});

test('production home lock keeps OAuth and unknown homes serial', async () => {
  for (const mode of ['oauth', 'unknown'] as const) {
    await withCodexHomeLockForTest(
      { mode, env: { ORVEX_CODEX_APIKEY_CONCURRENCY: '8' } },
      async (withLock) => {
        let active = 0;
        let peak = 0;
        const tasks = Array.from({ length: 3 }, () =>
          withLock(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
          }),
        );
        await Promise.all(tasks);
        assert.equal(peak, 1, `${mode} homes must remain serial`);
      },
    );
  }
});

test('resolveCodexTimeouts bounds wall and silence timers', () => {
  assert.deepEqual(resolveCodexTimeouts({}), { hardMs: 480_000, inactivityMs: 300_000 });
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
    { hardMs: 480_000, inactivityMs: 30_000 },
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

test('Codex lease-wait cancellation is normalized before attempt telemetry', () => {
  const controller = new AbortController();
  controller.abort();
  const normalized = normalizeCodexAttemptError(
    new Error('review cancelled while waiting for provider lease'),
    controller.signal,
  );
  assert.equal(normalized.name, 'ReviewCancelledError');
  assert.match(normalized.message, /codex-cli review cancelled/);
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
  const held = gate.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
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

test('a non-allowlisted Codex review fails before spawning the CLI', async (t) => {
  const previous = process.env.ORVEX_CODEX_CLI_REPOS;
  process.env.ORVEX_CODEX_CLI_REPOS = 'trusted/repo';
  t.after(() => {
    if (previous === undefined) delete process.env.ORVEX_CODEX_CLI_REPOS;
    else process.env.ORVEX_CODEX_CLI_REPOS = previous;
  });
  await assert.rejects(
    runCodexCliReview(
      [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
      { repoId: 'untrusted/repo' },
    ),
    /non-allowlisted repository/i,
  );
});

test('production Codex reviews refuse host execution when no internal container runtime is injected', async (t) => {
  const previous = process.env.ORVEX_CODEX_CLI_REPOS;
  process.env.ORVEX_CODEX_CLI_REPOS = 'trusted/repo';
  t.after(() => {
    if (previous === undefined) delete process.env.ORVEX_CODEX_CLI_REPOS;
    else process.env.ORVEX_CODEX_CLI_REPOS = previous;
  });
  await assert.rejects(
    runCodexCliReview([{ filename: 'src/a.ts', status: 'modified', patch: '+safe' }], {
      repoId: 'trusted/repo',
      cwd: '/tmp/orvex-rverify-not-used',
    }),
    /credential-isolating container runtime/,
  );
});

test('container protocol gives the internal runner only a private checkout, redacted prompt, and pinned Luna argv', async (t) => {
  const checkout = mkdtempSync(path.join(tmpdir(), 'orvex-rverify-codex-protocol-'));
  chmodSync(checkout, 0o700);
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  let request: CodexContainerRequest | undefined;
  const runtime: CodexContainerRuntime = {
    assertReady: async () => {},
    run: async (received) => {
      request = received;
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'container-thread' })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } })}`,
        stderr: '',
        lastMessage: '{"findings":[],"summary":"container ok"}',
        timedOut: false,
        durationMs: 1,
      };
    },
  };
  const result = await runCodexContainerExecForTest('review this redacted diff', {
    cwd: checkout,
    runtime,
  });
  assert.equal(result.threadId, 'container-thread');
  assert.equal(result.text, '{"findings":[],"summary":"container ok"}');
  assert.equal(request?.workdir, checkout);
  assert.equal(request?.prompt, 'review this redacted diff');
  assert.deepEqual(request?.args.slice(0, 5), [
    'exec',
    '--model',
    DEFAULT_CODEX_CLI_MODEL,
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(request?.args.includes('--sandbox'), false);
  assert.ok(request?.args.includes('model_reasoning_effort="max"'));
  assert.ok(request?.args.includes('/work'));
  assert.match(
    request?.lastMessageFile ?? '',
    new RegExp(
      `^${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.orvex-agentic/last-message-`,
    ),
  );
  assert.equal(
    request?.args.some((arg) => /sk-[A-Za-z0-9]|orvex-container-broker-placeholder/.test(arg)),
    false,
  );
});

test('container protocol refuses announced model substitution without a fallback call', async () => {
  const checkout = mkdtempSync(path.join(tmpdir(), 'orvex-rverify-codex-fallback-'));
  chmodSync(checkout, 0o700);
  try {
    const runtime: CodexContainerRuntime = {
      assertReady: async () => {},
      run: async () => ({
        exitCode: 0,
        stdout: 'gpt-5.6-luna not supported, falling back to gpt-5.5 max',
        stderr: '',
        lastMessage: '{"findings":[],"summary":"should not parse"}',
        timedOut: false,
        durationMs: 1,
      }),
    };
    await assert.rejects(
      runCodexContainerExecForTest('review', { cwd: checkout, runtime }),
      /refused model substitution/,
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('container protocol also refuses an announced model substitution on stderr', async (t) => {
  const checkout = mkdtempSync(path.join(tmpdir(), 'orvex-rverify-codex-stderr-fallback-'));
  chmodSync(checkout, 0o700);
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const runtime: CodexContainerRuntime = {
    assertReady: async () => {},
    run: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: 'gpt-5.6-luna is not supported; falling back to gpt-5.5 max',
      lastMessage: '{"findings":[],"summary":"must not parse"}',
      timedOut: false,
      durationMs: 1,
    }),
  };
  await assert.rejects(
    runCodexContainerExecForTest('review', { cwd: checkout, runtime }),
    /refused model substitution/,
  );
});

test('container protocol reports inactivity and wall-clock timeouts distinctly', async (t) => {
  const checkout = mkdtempSync(path.join(tmpdir(), 'orvex-rverify-codex-timeout-'));
  chmodSync(checkout, 0o700);
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const result = (inactivityTimedOut: boolean): CodexContainerRuntime => ({
    assertReady: async () => {},
    run: async () => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      lastMessage: '',
      timedOut: true,
      inactivityTimedOut,
      durationMs: 1,
    }),
  });
  await assert.rejects(
    runCodexContainerExecForTest('review', {
      cwd: checkout,
      runtime: result(true),
      hardMs: 2_000,
      inactivityMs: 1_000,
    }),
    /no container output for 1000ms/,
  );
  await assert.rejects(
    runCodexContainerExecForTest('review', {
      cwd: checkout,
      runtime: result(false),
      hardMs: 2_000,
      inactivityMs: 1_000,
    }),
    /exceeded 2000ms wall-clock cap/,
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

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fixture did not create ${file}`);
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
    hardMs: 5_000,
    inactivityMs: 3_000,
  });
  assert.equal(result.threadId, 'fixture-thread');
  const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
  assert.deepEqual(args.slice(0, 3), ['exec', '--model', DEFAULT_CODEX_CLI_MODEL]);
  assert.ok(args.includes('model_reasoning_effort="max"'));
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), [
    '--sandbox',
    'read-only',
  ]);
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('actual Codex child model substitution on stdout fails closed', async (t) => {
  const fixture = fakeCodex(`
console.log('gpt-5.6-luna not supported, falling back to gpt-5.5 max');
setInterval(() => {}, 1000);
`);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  await assert.rejects(
    runCodexExecForTest('review', {
      binaryPath: fixture.binary,
      hardMs: 5_000,
      inactivityMs: 3_000,
    }),
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
  const usage: Array<{ inputTokens: number; outputTokens: number; tokenSource?: string }> = [];
  const pending = runCodexExecForTest('review', {
    binaryPath: fixture.binary,
    hardMs: 5_000,
    inactivityMs: 2_000,
    env: { ...process.env, GRANDCHILD_FILE: grandchildFile },
    onUsage: (event) => usage.push(event),
  });
  await waitForFile(grandchildFile);
  await assert.rejects(pending, /produced no output/);
  const grandchildPid = Number(readFileSync(grandchildFile, 'utf8'));
  assert.equal(
    await waitForExit(grandchildPid),
    true,
    'grandchild process group member was killed',
  );
  assert.deepEqual(usage, [
    {
      inputTokens: 50_000,
      outputTokens: 5_000,
      tokenSource: 'estimate',
      model: DEFAULT_CODEX_CLI_MODEL,
      provider: 'codex-cli',
    },
  ]);
});

test('post-spawn cancellation kills the actual Codex process group', async (t) => {
  const fixture = fakeCodex(`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
fs.writeFileSync(process.env.GRANDCHILD_FILE, String(child.pid));
console.log(JSON.stringify({type:'thread.started', thread_id:'fixture-cancel'}));
setInterval(() => {}, 1000);
`);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const grandchildFile = path.join(fixture.dir, 'cancel-grandchild.pid');
  const controller = new AbortController();
  const pending = runCodexExecForTest('review', {
    binaryPath: fixture.binary,
    hardMs: 2_000,
    inactivityMs: 2_000,
    signal: controller.signal,
    env: { ...process.env, GRANDCHILD_FILE: grandchildFile },
  });

  await waitForFile(grandchildFile);
  controller.abort('pr_closed_mid_run');
  await assert.rejects(pending, /cancelled/i);
  const grandchildPid = Number(readFileSync(grandchildFile, 'utf8'));
  assert.equal(
    await waitForExit(grandchildPid),
    true,
    'cancel killed the grandchild process group member',
  );
});

test(
  'hard timeout settles despite delayed close and removes the temporary output directory',
  { timeout: 10_000 },
  async (t) => {
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
    const rejected = assert.rejects(
      runCodexExecForTest('review', {
        binaryPath: fixture.binary,
        hardMs: 3_000,
        inactivityMs: 5_000,
        env: { ...process.env, TMPDIR_FILE: tempDirFile },
      }),
      /wall-clock cap/,
    );
    await waitForFile(tempDirFile);
    await rejected;
    const codexTempDir = readFileSync(tempDirFile, 'utf8');
    assert.equal(
      existsSync(codexTempDir),
      false,
      'timeout cleanup removed the temp directory before delayed close',
    );
  },
);
