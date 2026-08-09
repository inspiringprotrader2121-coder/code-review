import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  buildSandboxDockerArgs,
  checkSandboxRuntimeReadiness,
  isDigestPinnedSandboxImage,
  prepareSandboxRuntimeForStartup,
  runInSandboxWithSpawnForTest,
} from './sandbox.js';

type SpawnCall = { command: string; args: string[] };
const PINNED_IMAGE = `registry.example/orvex-runtime@sha256:${'a'.repeat(64)}`;
const ROOTLESS_HOST = `unix:///run/user/${process.getuid!()}/docker.sock`;

function containerName(runArgs: string[]): string {
  const index = runArgs.indexOf('--name');
  assert.notEqual(index, -1, 'Docker run must set a deterministic container name');
  return runArgs[index + 1]!;
}

function fakeChild(): ReturnType<typeof spawn> {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  return child;
}

function fakeDocker(): {
  calls: SpawnCall[];
  run: ReturnType<typeof spawn>;
  spawn: typeof spawn;
} {
  const calls: SpawnCall[] = [];
  const run = fakeChild();
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    if (args[0] === 'run') return run;
    const cleanup = fakeChild();
    queueMicrotask(() => cleanup.emit('close', 0));
    return cleanup;
  }) as unknown as typeof spawn;
  return { calls, run, spawn: fakeSpawn };
}

test('buildSandboxDockerArgs keeps the internal sandbox contract without host secret mounts or image pulls', () => {
  const oldHostSecret = process.env.ORVEX_TEST_HOST_SECRET;
  process.env.ORVEX_TEST_HOST_SECRET = 'must-not-reach-container';
  try {
    const args = buildSandboxDockerArgs({
      workdir: '/tmp/orvex-review',
      image: PINNED_IMAGE,
      command: 'npm test',
      network: 'none',
      readOnlyWorkdir: true,
      env: { CI: '1' },
    }, 'orvex-rv-contract');

    assert.deepEqual(args.slice(0, 12), [
      'run', '--rm', '--pull', 'never', '--name', 'orvex-rv-contract',
      '--label', 'orvex.managed=true',
      '--label', 'orvex.runtime-verify=true',
      '--network', 'none',
    ]);
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('/tmp/orvex-review:/work:ro'));
    assert.ok(args.includes('ALL'));
    assert.ok(args.includes('no-new-privileges'));
    assert.ok(args.includes('1000:1000'));
    assert.deepEqual(args.filter((arg) => arg.startsWith('/')), [
      '/tmp:size=512m,noexec,nosuid,nodev',
      '/tmp/orvex-review:/work:ro',
      '/work',
    ]);
    assert.ok(args.includes('CI=1'));
    assert.equal(args.includes('ORVEX_TEST_HOST_SECRET=must-not-reach-container'), false);
  } finally {
    if (oldHostSecret === undefined) delete process.env.ORVEX_TEST_HOST_SECRET;
    else process.env.ORVEX_TEST_HOST_SECRET = oldHostSecret;
  }
});

test('runtime readiness requires an enabled, digest-pinned image before probing Docker', async () => {
  assert.equal(isDigestPinnedSandboxImage('node:22'), false);
  assert.equal(isDigestPinnedSandboxImage(`node@sha256:${'f'.repeat(64)}`), true);

  let probes = 0;
  const unavailable = await checkSandboxRuntimeReadiness({
    enabled: true,
    image: 'node:22',
    dockerHost: ROOTLESS_HOST,
    inspectImage: async () => {
      probes++;
      return true;
    },
  });
  assert.deepEqual(unavailable, {
    ready: false,
    reason: 'ORVEX_SANDBOX_IMAGE must be a digest-pinned image (for example registry/image@sha256:<64-hex>)',
  });
  assert.equal(probes, 0, 'a mutable image must never trigger a Docker probe');

  const disabled = await checkSandboxRuntimeReadiness({
    enabled: false,
    image: PINNED_IMAGE,
    inspectImage: async () => {
      probes++;
      return true;
    },
  });
  assert.deepEqual(disabled, { ready: false, reason: 'code execution is disabled' });
  assert.equal(probes, 0, 'disabled execution must not touch Docker');
});

test('runtime readiness accepts only a locally inspectable pinned image', async () => {
  let inspected: string | undefined;
  const ready = await checkSandboxRuntimeReadiness({
    enabled: true,
    image: PINNED_IMAGE,
    dockerHost: ROOTLESS_HOST,
    inspectRootlessRuntime: async () => true,
    inspectImage: async (image) => {
      inspected = image;
      return true;
    },
  });
  assert.deepEqual(ready, { ready: true, image: PINNED_IMAGE });
  assert.equal(inspected, PINNED_IMAGE);

  const unavailable = await checkSandboxRuntimeReadiness({
    enabled: true,
    image: PINNED_IMAGE,
    dockerHost: ROOTLESS_HOST,
    inspectRootlessRuntime: async () => true,
    inspectImage: async () => false,
  });
  assert.deepEqual(unavailable, {
    ready: false,
    reason: 'internal sandbox runtime or configured image is unavailable',
  });

  const rootful = await checkSandboxRuntimeReadiness({
    enabled: true,
    image: PINNED_IMAGE,
    dockerHost: 'unix:///var/run/docker.sock',
    inspectRootlessRuntime: async () => true,
    inspectImage: async () => true,
  });
  assert.match(rootful.ready ? '' : rootful.reason, /rootless socket/);

  const spoofedSocket = await checkSandboxRuntimeReadiness({
    enabled: true,
    image: PINNED_IMAGE,
    dockerHost: ROOTLESS_HOST,
    inspectRootlessRuntime: async () => false,
    inspectImage: async () => true,
  });
  assert.deepEqual(spoofedSocket, {
    ready: false,
    reason: 'selected Docker daemon does not report rootless mode',
  });
});

test('startup sandbox preparation is a no-op while code execution is disabled', async () => {
  let calls = 0;
  const result = await prepareSandboxRuntimeForStartup({
    enabled: false,
    runDockerCommand: async () => { calls++; return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
    checkReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
  });
  assert.deepEqual(result, { enabled: false, removedContainers: 0 });
  assert.equal(calls, 0);
});

test('startup sandbox preparation removes only doubly-labelled orphan containers before readiness', async () => {
  const calls: string[][] = [];
  const result = await prepareSandboxRuntimeForStartup({
    enabled: true,
    runDockerCommand: async (args) => {
      calls.push([...args]);
      if (args[0] === 'ps') return { exitCode: 0, stdout: '0123456789ab\nabcdefabcdef\n', stderr: '', timedOut: false };
      if (args[0] === 'inspect') return { exitCode: 0, stdout: 'true\ttrue\n', stderr: '', timedOut: false };
      if (args[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      throw new Error(`unexpected docker command ${args[0]}`);
    },
    checkReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
  });
  assert.deepEqual(result, { enabled: true, removedContainers: 2, image: PINNED_IMAGE });
  assert.deepEqual(calls[0], [
    'ps', '--all', '--quiet', '--filter', 'status=exited', '--filter', 'label=orvex.managed=true', '--filter', 'label=orvex.runtime-verify=true',
  ]);
  assert.deepEqual(calls.filter((args) => args[0] === 'rm'), [
    ['rm', '--force', '0123456789ab'],
    ['rm', '--force', 'abcdefabcdef'],
  ]);
  assert.deepEqual(calls.find((args) => args[0] === 'inspect'), [
    'inspect',
    '--format',
    '{{printf "%s\\t%s" (index .Config.Labels "orvex.managed") (index .Config.Labels "orvex.runtime-verify")}}',
    '0123456789ab',
  ]);
});

test('startup sandbox preparation fails closed when label verification or readiness fails', async () => {
  await assert.rejects(
    prepareSandboxRuntimeForStartup({
      enabled: true,
      runDockerCommand: async (args) => args[0] === 'ps'
        ? { exitCode: 0, stdout: '0123456789ab\n', stderr: '', timedOut: false }
        : { exitCode: 0, stdout: 'true\tfalse\n', stderr: '', timedOut: false },
      checkReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
    }),
    /required Orvex labels changed/,
  );

  await assert.rejects(
    prepareSandboxRuntimeForStartup({
      enabled: true,
      runDockerCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      checkReadiness: async () => ({ ready: false, reason: 'image unavailable' }),
    }),
    /internal sandbox readiness failed: image unavailable/,
  );
});

test('sandbox timeout kills then removes the labelled container and settles without close', async () => {
  const fake = fakeDocker();
  const result = await runInSandboxWithSpawnForTest({
    workdir: '/tmp/orvex-review', image: 'node:22', command: 'sleep infinity', timeoutMs: 10,
  }, fake.spawn);

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.deepEqual(fake.calls.map((call) => call.args[0]), ['run', 'kill', 'rm']);
  assert.equal(fake.calls[1]!.args[1], containerName(fake.calls[0]!.args));
  assert.deepEqual(fake.calls[2]!.args.slice(0, 2), ['rm', '--force']);
  assert.equal(fake.calls[2]!.args[2], containerName(fake.calls[0]!.args));
});

test('sandbox launch error kills then removes any partially-created container', async () => {
  const fake = fakeDocker();
  const pending = runInSandboxWithSpawnForTest({
    workdir: '/tmp/orvex-review', image: 'node:22', command: 'true',
  }, fake.spawn);
  queueMicrotask(() => fake.run.emit('error', new Error('daemon unavailable')));

  const result = await pending;
  assert.match(result.stderr, /failed to launch docker: daemon unavailable/);
  assert.deepEqual(fake.calls.slice(1).map((call) => call.args[0]), ['kill', 'rm']);
  assert.equal(fake.calls[1]!.args[1], containerName(fake.calls[0]!.args));
  assert.equal(fake.calls[2]!.args[2], containerName(fake.calls[0]!.args));
});

test('sandbox abort kills and removes the container without waiting for docker close', async () => {
  const fake = fakeDocker();
  const controller = new AbortController();
  const pending = runInSandboxWithSpawnForTest({
    workdir: '/tmp/orvex-review', image: 'node:22', command: 'sleep infinity', signal: controller.signal,
  }, fake.spawn);
  await Promise.resolve();
  controller.abort();

  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(fake.calls.slice(1).map((call) => call.args[0]), ['kill', 'rm']);
});

test('an already-aborted sandbox run never invokes Docker', async () => {
  const calls: SpawnCall[] = [];
  const controller = new AbortController();
  controller.abort('review closed');
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    return fakeChild();
  }) as unknown as typeof spawn;

  const result = await runInSandboxWithSpawnForTest({
    workdir: '/tmp/orvex-review', image: 'node:22', command: 'true', signal: controller.signal,
  }, fakeSpawn);

  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 0);
});
