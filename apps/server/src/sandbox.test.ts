import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  buildSandboxDockerArgs,
  checkCodexSandboxRuntimeReadiness,
  checkSandboxRuntimeReadiness,
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  isDigestPinnedSandboxImage,
  prepareSandboxRuntimeForStartup,
  runInSandboxWithSpawnForTest,
  runCodexInSandboxWithSpawnForTest,
} from './sandbox.js';
import { createBrokerCapabilityToken, readBrokerSigningKey } from './sandbox/broker-capability.js';

type SpawnCall = { command: string; args: string[] };
const PINNED_IMAGE = `registry.example/orvex-runtime@sha256:${'a'.repeat(64)}`;
const ROOTLESS_HOST = `unix:///run/user/${process.getuid!()}/docker.sock`;
const privateSocket = async () => true;
const BROKER_TOKEN = 'orvex1.dGVzdC1wYXlsb2Fk.dGVzdC1zaWduYXR1cmU';

function createSandboxWorkdir(): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-rverify-test-'));
  fs.chmodSync(workdir, 0o700);
  return workdir;
}

function containerName(runArgs: string[]): string {
  const index = runArgs.indexOf('--name');
  assert.notEqual(index, -1, 'Docker run must set a deterministic container name');
  return runArgs[index + 1]!;
}

function fakeChild(): ReturnType<typeof spawn> {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  Object.assign(child, {
    stdin: new PassThrough(),
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
  let containerExists = true;
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    if (args[0] === 'run') return run;
    const cleanup = fakeChild();
    queueMicrotask(() => {
      if (args[0] === 'inspect') {
        if (containerExists) (cleanup.stdout as PassThrough).write('true\ttrue\n');
        else (cleanup.stderr as PassThrough).write('Error: No such object\n');
        cleanup.emit('close', containerExists ? 0 : 1);
        return;
      }
      if (args[0] === 'rm') containerExists = false;
      cleanup.emit('close', 0);
    });
    return cleanup;
  }) as unknown as typeof spawn;
  return { calls, run, spawn: fakeSpawn };
}

test('buildSandboxDockerArgs keeps the internal sandbox contract without host secret mounts or image pulls', () => {
  const workdir = createSandboxWorkdir();
  try {
    const args = buildSandboxDockerArgs(
      {
        workdir,
        image: PINNED_IMAGE,
        command: 'npm test',
        readOnlyWorkdir: true,
      },
      'orvex-rv-contract',
    );

    assert.deepEqual(args.slice(0, 6), [
      'run',
      '--rm',
      '--pull',
      'never',
      '--name',
      'orvex-rv-contract',
    ]);
    assert.ok(args.includes('orvex.managed=true'));
    assert.ok(args.includes('orvex.runtime-verify=true'));
    assert.ok(args.includes(`orvex.owner-pid=${process.pid}`));
    assert.ok(args.includes('--read-only'));
    assert.ok(
      args.includes(
        `type=bind,src=${fs.realpathSync(workdir)},dst=/work,bind-propagation=rprivate,readonly`,
      ),
    );
    assert.ok(args.includes('ALL'));
    assert.ok(args.includes('no-new-privileges'));
    assert.ok(args.includes('0:0'));
    assert.ok(args.includes('--ipc'));
    assert.ok(args.includes('--init'));
    assert.ok(args.includes('nofile=256:256'));
    assert.ok(args.includes('fsize=536870912:536870912'));
    assert.deepEqual(
      args.filter((arg) => arg.startsWith('/')),
      ['/tmp:size=256m,noexec,nosuid,nodev', '/work'],
    );
    assert.equal(args[args.indexOf('--memory') + 1], '1g');
    assert.equal(args[args.indexOf('--cpus') + 1], '0.75');
    assert.equal(args[args.indexOf('--pids-limit') + 1], '256');
    assert.equal(
      args.some((arg) => arg.startsWith('nproc=')),
      false,
      'rootless containers share RLIMIT_NPROC through the mapped service user; the PID cgroup is per container',
    );
    assert.throws(
      () =>
        buildSandboxDockerArgs(
          {
            workdir,
            image: PINNED_IMAGE,
            command: 'true',
            profile: 'agentic-codex',
          },
          'orvex-codex-without-capability',
        ),
      /requires a valid per-container broker capability/,
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runtime readiness requires an enabled, digest-pinned image before probing Docker', async () => {
  assert.equal(isDigestPinnedSandboxImage('node:22'), false);
  assert.equal(isDigestPinnedSandboxImage(`node@sha256:${'f'.repeat(64)}`), true);
  assert.equal(isDigestPinnedSandboxImage(`sha256:${'e'.repeat(64)}`), true);

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
    reason:
      'ORVEX_SANDBOX_IMAGE must be a registry digest or immutable local image ID (sha256:<64-hex>)',
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
    inspectDockerSocket: privateSocket,
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
    inspectDockerSocket: privateSocket,
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
    inspectDockerSocket: privateSocket,
    inspectRootlessRuntime: async () => false,
    inspectImage: async () => true,
  });
  assert.deepEqual(spoofedSocket, {
    ready: false,
    reason: 'selected Docker daemon does not report rootless mode',
  });
});

test('agentic Codex readiness requires a pinned broker on the internal-only network', async () => {
  const base = {
    enabled: true,
    image: PINNED_IMAGE,
    dockerHost: ROOTLESS_HOST,
    inspectDockerSocket: privateSocket,
    inspectRootlessRuntime: async () => true,
    inspectImage: async () => true,
    inspectCodexBinary: async () => true,
    brokerImage: `registry.example/orvex-egress@sha256:${'b'.repeat(64)}`,
    inspectBrokerSigningKey: async () => true,
  };
  const unavailable = await checkCodexSandboxRuntimeReadiness({
    ...base,
    inspectEgressBoundary: async () => false,
  });
  assert.deepEqual(unavailable, {
    ready: false,
    reason:
      'internal Codex egress broker is not a pinned container on the required internal-only network',
  });
  const ready = await checkCodexSandboxRuntimeReadiness({
    ...base,
    inspectEgressBoundary: async (network, broker, image) => {
      assert.equal(network, 'orvex-agentic-internal');
      assert.equal(broker, 'orvex-openai-egress');
      assert.equal(image, base.brokerImage);
      return true;
    },
  });
  assert.deepEqual(ready, { ready: true, image: PINNED_IMAGE });

  const missingBinary = await checkCodexSandboxRuntimeReadiness({
    ...base,
    inspectCodexBinary: async () => false,
    inspectEgressBoundary: async () => true,
  });
  assert.deepEqual(missingBinary, {
    ready: false,
    reason: 'internal Codex sandbox image is missing the pinned Codex CLI binary',
  });

  const missingSigningKey = await checkCodexSandboxRuntimeReadiness({
    ...base,
    inspectBrokerSigningKey: async () => false,
    inspectEgressBoundary: async () => true,
  });
  assert.deepEqual(missingSigningKey, {
    ready: false,
    reason: 'internal Codex broker capability signing key is unavailable or not private',
  });
});

test('agentic Codex readiness coalesces probes, briefly caches success, and isolates cancellation', async () => {
  const probes = {
    socket: 0,
    rootless: 0,
    image: 0,
    binary: 0,
    signingKey: 0,
    boundary: 0,
  };
  const shared = {
    enabled: true,
    image: PINNED_IMAGE,
    dockerHost: ROOTLESS_HOST,
    inspectDockerSocket: async () => {
      probes.socket += 1;
      return true;
    },
    inspectRootlessRuntime: async () => {
      probes.rootless += 1;
      return true;
    },
    inspectImage: async () => {
      probes.image += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    },
    inspectCodexBinary: async () => {
      probes.binary += 1;
      return true;
    },
    brokerImage: `registry.example/orvex-egress@sha256:${'c'.repeat(64)}`,
    inspectBrokerSigningKey: async () => {
      probes.signingKey += 1;
      return true;
    },
    inspectEgressBoundary: async () => {
      probes.boundary += 1;
      return true;
    },
  };

  const [first, second] = await Promise.all([
    checkCodexSandboxRuntimeReadiness(shared),
    checkCodexSandboxRuntimeReadiness(shared),
  ]);
  assert.deepEqual(first, { ready: true, image: PINNED_IMAGE });
  assert.deepEqual(second, { ready: true, image: PINNED_IMAGE });
  assert.deepEqual(probes, {
    socket: 1,
    rootless: 1,
    image: 1,
    binary: 1,
    signingKey: 1,
    boundary: 1,
  });

  assert.deepEqual(await checkCodexSandboxRuntimeReadiness(shared), {
    ready: true,
    image: PINNED_IMAGE,
  });
  assert.equal(probes.boundary, 1, 'a successful probe is reused only for the short cache window');

  let releaseImage: (() => void) | undefined;
  let imageProbeStarted: (() => void) | undefined;
  const slow = {
    ...shared,
    inspectImage: async () => {
      imageProbeStarted?.();
      await new Promise<void>((resolve) => {
        releaseImage = resolve;
      });
      return true;
    },
  };
  const controller = new AbortController();
  const cancelled = checkCodexSandboxRuntimeReadiness({ ...slow, signal: controller.signal });
  await new Promise<void>((resolve) => {
    imageProbeStarted = resolve;
  });
  const peer = checkCodexSandboxRuntimeReadiness(slow);
  controller.abort();
  assert.deepEqual(await cancelled, { ready: false, reason: 'runtime verification cancelled' });
  releaseImage?.();
  assert.deepEqual(await peer, { ready: true, image: PINNED_IMAGE });
});

test('runtime readiness rejects a rootless socket that is not private to the service account', async () => {
  const result = await checkSandboxRuntimeReadiness({
    enabled: true,
    image: PINNED_IMAGE,
    dockerHost: ROOTLESS_HOST,
    inspectDockerSocket: async () => false,
    inspectRootlessRuntime: async () => true,
    inspectImage: async () => true,
  });
  assert.deepEqual(result, {
    ready: false,
    reason: 'rootless Docker socket is not a private local service-account socket',
  });
});

test('runtime readiness rejects Docker contexts because they can override the local socket', async () => {
  const result = await checkSandboxRuntimeReadiness({
    enabled: true,
    image: PINNED_IMAGE,
    dockerHost: ROOTLESS_HOST,
    dockerContext: 'remote-production',
    inspectDockerSocket: privateSocket,
    inspectRootlessRuntime: async () => true,
    inspectImage: async () => true,
  });
  assert.deepEqual(result, {
    ready: false,
    reason: 'DOCKER_CONTEXT must be unset so Docker cannot select a non-local daemon',
  });
});

test('startup sandbox preparation is a no-op while code execution is disabled', async () => {
  let calls = 0;
  const result = await prepareSandboxRuntimeForStartup({
    enabled: false,
    runDockerCommand: async () => {
      calls++;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
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
      if (args[0] === 'ps')
        return { exitCode: 0, stdout: '0123456789ab\nabcdefabcdef\n', stderr: '', timedOut: false };
      if (args[0] === 'inspect')
        return { exitCode: 0, stdout: 'true\ttrue\n', stderr: '', timedOut: false };
      if (args[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      throw new Error(`unexpected docker command ${args[0]}`);
    },
    checkReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
  });
  assert.deepEqual(result, { enabled: true, removedContainers: 2, image: PINNED_IMAGE });
  assert.deepEqual(calls[0], [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    'label=orvex.managed=true',
    '--filter',
    'label=orvex.runtime-verify=true',
  ]);
  assert.deepEqual(
    calls.filter((args) => args[0] === 'rm'),
    [
      ['rm', '--force', '0123456789ab'],
      ['rm', '--force', 'abcdefabcdef'],
    ],
  );
  assert.deepEqual(
    calls.find((args) => args[0] === 'inspect'),
    [
      'inspect',
      '--format',
      '{{printf "%s\\t%s\\t%s\\t%s" (index .Config.Labels "orvex.managed") (index .Config.Labels "orvex.runtime-verify") (index .Config.Labels "orvex.owner-pid") (index .Config.Labels "orvex.owner-token")}}',
      '0123456789ab',
    ],
  );
});

test('startup cleanup retains containers whose owning worker is still alive', async () => {
  const calls: string[][] = [];
  const slotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-slot-owner-test-'));
  const ownerToken = '11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(path.join(slotDirectory, 'slot-0'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(slotDirectory, 'slot-0', 'owner.json'),
    JSON.stringify({ pid: 4321, token: ownerToken, processIdentity: 'portable' }),
    { mode: 0o600 },
  );
  try {
    const result = await prepareSandboxRuntimeForStartup({
      enabled: true,
      runtime: { ...DEFAULT_SANDBOX_RUNTIME_OPTIONS, slotDirectory },
      isProcessAlive: (pid) => pid === 4321,
      runDockerCommand: async (args) => {
        calls.push([...args]);
        if (args[0] === 'ps')
          return { exitCode: 0, stdout: '0123456789ab\n', stderr: '', timedOut: false };
        if (args[0] === 'inspect')
          return {
            exitCode: 0,
            stdout: `true\ttrue\t4321\t${ownerToken}\n`,
            stderr: '',
            timedOut: false,
          };
        throw new Error(`unexpected docker command ${args[0]}`);
      },
      checkReadiness: async () => ({ ready: true, image: PINNED_IMAGE }),
    });
    assert.deepEqual(result, { enabled: true, removedContainers: 0, image: PINNED_IMAGE });
    assert.equal(
      calls.some((args) => args[0] === 'rm'),
      false,
    );
  } finally {
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('startup sandbox preparation fails closed when label verification or readiness fails', async () => {
  await assert.rejects(
    prepareSandboxRuntimeForStartup({
      enabled: true,
      runDockerCommand: async (args) =>
        args[0] === 'ps'
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

  let dockerCalls = 0;
  await assert.rejects(
    prepareSandboxRuntimeForStartup({
      enabled: true,
      runDockerCommand: async () => {
        dockerCalls++;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
      checkReadiness: async () => ({ ready: false, reason: 'rootless daemon required' }),
    }),
    /internal sandbox readiness failed: rootless daemon required/,
  );
  assert.equal(dockerCalls, 0, 'startup must not clean up containers on an untrusted daemon');
});

test('sandbox timeout kills then removes the labelled container and settles without close', async () => {
  const fake = fakeDocker();
  const workdir = createSandboxWorkdir();
  try {
    const result = await runInSandboxWithSpawnForTest(
      {
        workdir,
        image: PINNED_IMAGE,
        command: 'sleep infinity',
        timeoutMs: 10,
      },
      fake.spawn,
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.deepEqual(
      fake.calls.map((call) => call.args[0]),
      ['run', 'inspect', 'kill', 'rm', 'inspect'],
    );
    assert.equal(fake.calls[2]!.args[1], containerName(fake.calls[0]!.args));
    assert.deepEqual(fake.calls[3]!.args.slice(0, 2), ['rm', '--force']);
    assert.equal(fake.calls[3]!.args[2], containerName(fake.calls[0]!.args));
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('sandbox launch error kills then removes any partially-created container', async () => {
  const fake = fakeDocker();
  const workdir = createSandboxWorkdir();
  try {
    const pending = runInSandboxWithSpawnForTest(
      {
        workdir,
        image: PINNED_IMAGE,
        command: 'true',
      },
      fake.spawn,
    );
    queueMicrotask(() => fake.run.emit('error', new Error('daemon unavailable')));

    const result = await pending;
    assert.match(result.stderr, /failed to launch docker: daemon unavailable/);
    assert.deepEqual(
      fake.calls.slice(1).map((call) => call.args[0]),
      ['inspect', 'kill', 'rm', 'inspect'],
    );
    assert.equal(fake.calls[2]!.args[1], containerName(fake.calls[0]!.args));
    assert.equal(fake.calls[3]!.args[2], containerName(fake.calls[0]!.args));
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('sandbox cleanup retries until a delayed container is observable before releasing capacity', async () => {
  const calls: SpawnCall[] = [];
  const run = fakeChild();
  let inspections = 0;
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    if (args[0] === 'run') return run;
    const child = fakeChild();
    queueMicrotask(() => {
      if (args[0] === 'inspect') {
        inspections++;
        if (inspections === 1) {
          (child.stderr as PassThrough).write('daemon not ready\n');
          child.emit('close', 1);
          return;
        }
        if (inspections === 2) {
          (child.stdout as PassThrough).write('true\ttrue\n');
          child.emit('close', 0);
          return;
        }
        (child.stderr as PassThrough).write('Error: No such object\n');
        child.emit('close', 1);
        return;
      }
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof spawn;
  const workdir = createSandboxWorkdir();
  try {
    const result = await runInSandboxWithSpawnForTest(
      { workdir, image: PINNED_IMAGE, command: 'sleep infinity', timeoutMs: 10 },
      fakeSpawn,
    );
    assert.equal(result.timedOut, true);
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ['run', 'inspect', 'inspect', 'kill', 'rm', 'inspect'],
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('sandbox abort kills and removes the container without waiting for docker close', async () => {
  const fake = fakeDocker();
  const workdir = createSandboxWorkdir();
  const controller = new AbortController();
  const pending = runInSandboxWithSpawnForTest(
    {
      workdir,
      image: PINNED_IMAGE,
      command: 'sleep infinity',
      signal: controller.signal,
    },
    fake.spawn,
  );
  await Promise.resolve();
  controller.abort();

  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    fake.calls.slice(1).map((call) => call.args[0]),
    ['inspect', 'kill', 'rm', 'inspect'],
  );
  fs.rmSync(workdir, { recursive: true, force: true });
});

test('an already-aborted sandbox run never invokes Docker', async () => {
  const calls: SpawnCall[] = [];
  const controller = new AbortController();
  controller.abort('review closed');
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    return fakeChild();
  }) as unknown as typeof spawn;

  const result = await runInSandboxWithSpawnForTest(
    {
      workdir: '/tmp/orvex-rverify-test-aborted',
      image: PINNED_IMAGE,
      command: 'true',
      signal: controller.signal,
    },
    fakeSpawn,
  );

  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 0);
});

test('sandbox rejects mutable images, shared permissions, traversal, and symlink bind sources before Docker', async () => {
  const calls: SpawnCall[] = [];
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    return fakeChild();
  }) as unknown as typeof spawn;
  const workdir = createSandboxWorkdir();
  const symlink = path.join(os.tmpdir(), 'orvex-rverify-test-link');
  try {
    const mutable = await runInSandboxWithSpawnForTest(
      { workdir, image: 'node:22', command: 'true' },
      fakeSpawn,
    );
    assert.match(mutable.stderr, /digest-pinned/);

    fs.chmodSync(workdir, 0o755);
    const exposed = await runInSandboxWithSpawnForTest(
      { workdir, image: PINNED_IMAGE, command: 'true' },
      fakeSpawn,
    );
    assert.match(exposed.stderr, /group- or world-accessible/);
    fs.chmodSync(workdir, 0o700);

    fs.rmSync(symlink, { recursive: true, force: true });
    fs.symlinkSync(workdir, symlink);
    const linked = await runInSandboxWithSpawnForTest(
      { workdir: symlink, image: PINNED_IMAGE, command: 'true' },
      fakeSpawn,
    );
    assert.match(linked.stderr, /not an Orvex runtime verification checkout|not a symlink/);
    const traversal = await runInSandboxWithSpawnForTest(
      { workdir: `${workdir}/../etc`, image: PINNED_IMAGE, command: 'true' },
      fakeSpawn,
    );
    assert.match(traversal.stderr, /not an Orvex runtime verification checkout/);
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(symlink, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('cleanup refuses to kill or remove a container whose labels do not prove ownership', async () => {
  const calls: SpawnCall[] = [];
  const run = fakeChild();
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args: [...args] });
    if (args[0] === 'run') return run;
    const child = fakeChild();
    queueMicrotask(() => {
      if (args[0] === 'inspect') (child.stdout as PassThrough).write('true\tfalse\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof spawn;
  const workdir = createSandboxWorkdir();
  const slotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-unsafe-label-slot-test-'));
  try {
    const result = await runInSandboxWithSpawnForTest(
      {
        workdir,
        image: PINNED_IMAGE,
        command: 'sleep infinity',
        timeoutMs: 10,
      },
      fakeSpawn,
      { ...DEFAULT_SANDBOX_RUNTIME_OPTIONS, slotDirectory },
    );
    assert.equal(result.timedOut, true);
    assert.equal(
      calls.some((call) => call.args[0] === 'kill' || call.args[0] === 'rm'),
      false,
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('a cleanup failure fences its host slot until container absence is proven', async () => {
  const slotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-fenced-slot-test-'));
  const firstWorkdir = createSandboxWorkdir();
  const secondWorkdir = createSandboxWorkdir();
  const run = fakeChild();
  const fakeSpawn = ((_: string, args: readonly string[] = []) => {
    if (args[0] === 'run') return run;
    const child = fakeChild();
    queueMicrotask(() => {
      if (args[0] === 'inspect') (child.stdout as PassThrough).write('true\tfalse\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof spawn;
  const runtime = {
    ...DEFAULT_SANDBOX_RUNTIME_OPTIONS,
    maxConcurrentSandboxes: 1,
    slotDirectory,
    slotWaitMs: 20,
  };
  try {
    const first = runInSandboxWithSpawnForTest(
      { workdir: firstWorkdir, image: PINNED_IMAGE, command: 'sleep', timeoutMs: 5 },
      fakeSpawn,
      runtime,
    );
    assert.equal((await first).timedOut, true);
    await assert.rejects(
      runInSandboxWithSpawnForTest(
        { workdir: secondWorkdir, image: PINNED_IMAGE, command: 'true' },
        fakeSpawn,
        runtime,
      ),
      /slot wait timed out/,
    );
  } finally {
    fs.rmSync(firstWorkdir, { recursive: true, force: true });
    fs.rmSync(secondWorkdir, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('sandbox prevents concurrent reuse of the same checkout and caps combined output', async () => {
  const fake = fakeDocker();
  const workdir = createSandboxWorkdir();
  const controller = new AbortController();
  try {
    const first = runInSandboxWithSpawnForTest(
      {
        workdir,
        image: PINNED_IMAGE,
        command: 'sleep infinity',
        signal: controller.signal,
      },
      fake.spawn,
    );
    for (let attempt = 0; attempt < 100 && fake.calls.length === 0; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(fake.calls[0]?.args[0], 'run');
    const second = await runInSandboxWithSpawnForTest(
      { workdir, image: PINNED_IMAGE, command: 'true' },
      fake.spawn,
    );
    assert.match(second.stderr, /concurrent reuse/);
    (fake.run.stdout as PassThrough).write(Buffer.alloc(48_000, 'a'));
    (fake.run.stderr as PassThrough).write(Buffer.alloc(48_000, 'b'));
    controller.abort();
    const firstResult = await first;
    assert.ok(
      Buffer.byteLength(firstResult.stdout) + Buffer.byteLength(firstResult.stderr) <= 64_000 + 32,
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('host-wide sandbox slots bound one hundred tasks at eight containers and reclaim dead leases', async () => {
  const slotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-sandbox-slots-test-'));
  const staleSlot = path.join(slotDirectory, 'slot-0');
  fs.mkdirSync(staleSlot, { mode: 0o700 });
  fs.writeFileSync(
    path.join(staleSlot, 'owner.json'),
    JSON.stringify({
      pid: 999_999_999,
      acquiredAt: 0,
      token: randomUUID(),
      processIdentity: '999999999:dead',
    }),
    { mode: 0o600 },
  );
  const workdirs = Array.from({ length: 100 }, () => createSandboxWorkdir());
  let active = 0;
  let peak = 0;
  const activeNames = new Set<string>();
  const fakeSpawn = ((_: string, args: readonly string[] = []) => {
    const child = fakeChild();
    if (args[0] === 'run') {
      const name = containerName([...args]);
      activeNames.add(name);
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        activeNames.delete(name);
        child.emit('close', 0);
      }, 2);
    } else if (args[0] === 'inspect') {
      queueMicrotask(() => {
        const exists = activeNames.has(args.at(-1) ?? '');
        if (exists) (child.stdout as PassThrough).write('true\ttrue\n');
        else (child.stderr as PassThrough).write('Error: No such object\n');
        child.emit('close', exists ? 0 : 1);
      });
    } else {
      queueMicrotask(() => child.emit('close', 0));
    }
    return child;
  }) as unknown as typeof spawn;
  const runtime = {
    ...DEFAULT_SANDBOX_RUNTIME_OPTIONS,
    maxConcurrentSandboxes: 8,
    slotDirectory,
    slotStaleMs: 1,
    slotWaitMs: 10_000,
  };
  try {
    const results = await Promise.all(
      workdirs.map((workdir) =>
        runInSandboxWithSpawnForTest(
          { workdir, image: PINNED_IMAGE, command: 'true' },
          fakeSpawn,
          runtime,
        ),
      ),
    );
    assert.equal(peak, 8);
    assert.ok(results.every((result) => result.exitCode === 0));
    assert.equal(fs.readdirSync(slotDirectory).length, 0, 'all leases are released');
  } finally {
    for (const workdir of workdirs) fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('agentic Codex container mounts only its private checkout and receives no host credential or proxy', async () => {
  const fake = fakeDocker();
  const workdir = createSandboxWorkdir();
  const output = path.join(workdir, '.orvex-agentic', 'last-message-a1b2c3d4.txt');
  try {
    const pending = runCodexInSandboxWithSpawnForTest(
      {
        workdir,
        image: PINNED_IMAGE,
        args: [
          'exec',
          '--ignore-user-config',
          '--model',
          'gpt-5.6-luna',
          '--json',
          '--output-last-message',
          '/work/.orvex-agentic/last-message-a1b2c3d4.txt',
          '-',
        ],
        prompt: 'redacted review prompt',
        lastMessageFile: output,
        timeoutMs: 5_000,
        inactivityTimeoutMs: 2_000,
        brokerToken: BROKER_TOKEN,
      },
      fake.spawn,
    );
    for (let attempt = 0; attempt < 100 && fake.calls.length === 0; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    const args = fake.calls[0]!.args;
    assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--pull', 'never']);
    assert.ok(args.includes('--interactive'));
    assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), [
      '--network',
      'orvex-agentic-internal',
    ]);
    assert.ok(
      args.includes(
        `type=bind,src=${fs.realpathSync(workdir)},dst=/work,bind-propagation=rprivate,readonly`,
      ),
    );
    assert.equal(args.includes('none'), true, 'IPC remains disabled even for agentic execution');
    assert.equal(
      args.some((arg) => /CODEX_HOME=\/home|OPENAI_API_KEY=sk-|HTTPS?_PROXY=/.test(arg)),
      false,
    );
    assert.ok(args.includes(`OPENAI_API_KEY=${BROKER_TOKEN}`));
    assert.deepEqual(
      args
        .slice(args.indexOf('/codex-home:size=16m,noexec,nosuid,nodev,mode=0700') - 1)
        .slice(0, 2),
      ['--tmpfs', '/codex-home:size=16m,noexec,nosuid,nodev,mode=0700'],
    );
    assert.ok(args.includes('CODEX_HOME=/codex-home'));
    const command = args.at(-1) ?? '';
    assert.match(command, /^mkdir -p '\/codex-home' && chmod 700 '\/codex-home' && node /);
    assert.match(command, /node '\/opt\/orvex\/node_modules\/@openai\/codex\/bin\/codex\.js'/);
    assert.match(command, /'model_provider="orvex_broker"'/);
    assert.match(
      command,
      /'model_providers\.orvex_broker\.base_url="http:\/\/orvex-openai-egress:8080\/v1"'/,
    );
    assert.match(command, /'model_providers\.orvex_broker\.supports_websockets=false'/);
    assert.match(command, /'model_providers\.orvex_broker\.request_max_retries=1'/);
    assert.match(command, /'model_providers\.orvex_broker\.stream_max_retries=1'/);
    assert.match(command, /\/v1\/orvex\/usage/);
    assert.match(command, /codex_status=\$\?/);
    assert.match(command, /exit "\$codex_status"/);
    const shellSyntax = spawnSync('sh', ['-n', '-c', command], { encoding: 'utf8' });
    assert.equal(shellSyntax.status, 0, shellSyntax.stderr);
    assert.ok(
      command.indexOf("'--ignore-user-config'") <
        command.indexOf('\'model_provider="orvex_broker"\''),
      'broker overrides must be applied after Codex resets user configuration',
    );
    assert.doesNotMatch(command, /prompt-|redacted review prompt/);
    assert.equal(
      (fake.run.stdin as PassThrough).read()?.toString(),
      'redacted review prompt',
      'the prompt is delivered only through attached container stdin',
    );

    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, '{"findings":[],"summary":"ok"}', { mode: 0o600 });
    (fake.run.stdout as PassThrough).write(
      JSON.stringify({ type: 'thread.started', thread_id: 'container-thread' }),
    );
    fake.run.emit('close', 0);
    const result = await pending;
    assert.equal(result.lastMessage, '{"findings":[],"summary":"ok"}');
    assert.equal(fs.existsSync(output), false, 'response artifact is removed after capture');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('agentic Codex runner rejects output traversal and cleans up a silent container on inactivity', async () => {
  const fake = fakeDocker();
  const workdir = createSandboxWorkdir();
  try {
    await assert.rejects(
      runCodexInSandboxWithSpawnForTest(
        {
          workdir,
          image: PINNED_IMAGE,
          args: ['exec', '--ignore-user-config', '-'],
          prompt: 'x',
          lastMessageFile: path.join(workdir, '..', 'last-message-a1.txt'),
          timeoutMs: 100,
          inactivityTimeoutMs: 10,
          brokerToken: BROKER_TOKEN,
        },
        fake.spawn,
      ),
      /output path/,
    );
    assert.equal(fake.calls.length, 0, 'invalid output path must not start Docker');

    const output = path.join(workdir, '.orvex-agentic', 'last-message-abc123.txt');
    await assert.rejects(
      runCodexInSandboxWithSpawnForTest(
        {
          workdir,
          image: PINNED_IMAGE,
          args: ['exec', '-'],
          prompt: 'x',
          lastMessageFile: output,
          timeoutMs: 500,
          inactivityTimeoutMs: 10,
          brokerToken: BROKER_TOKEN,
        },
        fake.spawn,
      ),
      /requires config isolation/,
    );
    assert.equal(fake.calls.length, 0, 'missing config isolation must not start Docker');

    const result = await runCodexInSandboxWithSpawnForTest(
      {
        workdir,
        image: PINNED_IMAGE,
        args: ['exec', '--ignore-user-config', '-'],
        prompt: 'x',
        lastMessageFile: output,
        timeoutMs: 500,
        inactivityTimeoutMs: 10,
        brokerToken: BROKER_TOKEN,
      },
      fake.spawn,
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.inactivityTimedOut, true);
    assert.deepEqual(
      fake.calls.slice(1).map((call) => call.args[0]),
      ['inspect', 'kill', 'rm', 'inspect'],
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('agentic Codex fails closed when Docker does not expose the requested stdin pipe', async () => {
  const fake = fakeDocker();
  const workdir = createSandboxWorkdir();
  const output = path.join(workdir, '.orvex-agentic', 'last-message-feed123.txt');
  Object.assign(fake.run, { stdin: null });
  try {
    const result = await runCodexInSandboxWithSpawnForTest(
      {
        workdir,
        image: PINNED_IMAGE,
        args: ['exec', '--ignore-user-config', '-'],
        prompt: 'private prompt',
        lastMessageFile: output,
        timeoutMs: 500,
        inactivityTimeoutMs: 100,
        brokerToken: BROKER_TOKEN,
      },
      fake.spawn,
    );
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /stdin pipe unavailable/);
    assert.deepEqual(
      fake.calls.slice(1).map((call) => call.args[0]),
      ['inspect', 'kill', 'rm', 'inspect'],
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('each agentic container receives a distinct bounded broker capability', () => {
  const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
  const first = createBrokerCapabilityToken(300_000, {
    signingKey,
    now: 1_800_000_000_000,
  });
  const second = createBrokerCapabilityToken(300_000, {
    signingKey,
    now: 1_800_000_000_000,
  });
  assert.match(first, /^orvex1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(signingKey), false);
});

test('broker signing keys must be bounded private regular files owned by the service account', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-broker-key-'));
  const keyFile = path.join(directory, 'key');
  const symlink = path.join(directory, 'link');
  try {
    fs.writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 });
    assert.equal(readBrokerSigningKey(keyFile), 'a'.repeat(64));
    fs.chmodSync(keyFile, 0o644);
    assert.throws(() => readBrokerSigningKey(keyFile), /not a private service-account file/);
    fs.chmodSync(keyFile, 0o600);
    fs.symlinkSync(keyFile, symlink);
    assert.throws(() => readBrokerSigningKey(symlink), /not a private service-account file/);
    fs.writeFileSync(keyFile, 'too-short', { mode: 0o600 });
    assert.throws(() => readBrokerSigningKey(keyFile), /not a private service-account file/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
