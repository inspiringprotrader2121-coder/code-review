import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { DEFAULT_SANDBOX_RUNTIME_OPTIONS } from './contracts.js';
import { runInSandboxWithSpawnForTest } from './execution.js';

const PINNED_IMAGE = `registry.example/orvex-runtime@sha256:${'a'.repeat(64)}`;

function createSandboxWorkdir(): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-slot-wait-test-'));
  fs.chmodSync(workdir, 0o700);
  return workdir;
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

test('a full sandbox host waits for a slot instead of failing the review immediately', async () => {
  const slotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-slot-wait-dir-'));
  const firstWorkdir = createSandboxWorkdir();
  const secondWorkdir = createSandboxWorkdir();
  const firstRun = fakeChild();
  let secondStarted = false;
  const fakeSpawn = ((_: string, args: readonly string[] = []) => {
    if (args[0] === 'run') {
      if (!secondStarted) return firstRun;
      const second = fakeChild();
      secondStarted = true;
      queueMicrotask(() => second.emit('close', 0));
      return second;
    }
    const child = fakeChild();
    queueMicrotask(() => {
      if (args[0] === 'inspect') child.stderr.write('Error: No such object\n');
      child.emit('close', args[0] === 'inspect' ? 1 : 0);
    });
    return child;
  }) as unknown as typeof spawn;
  const runtime = {
    ...DEFAULT_SANDBOX_RUNTIME_OPTIONS,
    maxConcurrentSandboxes: 1,
    slotDirectory,
    slotWaitMs: 2_000,
  };
  try {
    const first = runInSandboxWithSpawnForTest(
      { workdir: firstWorkdir, image: PINNED_IMAGE, command: 'sleep', timeoutMs: 5_000 },
      fakeSpawn,
      runtime,
    );
    const second = runInSandboxWithSpawnForTest(
      { workdir: secondWorkdir, image: PINNED_IMAGE, command: 'true', timeoutMs: 5_000 },
      fakeSpawn,
      runtime,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    firstRun.emit('close', 0);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.exitCode, 0);
    assert.equal(secondResult.exitCode, 0);
    assert.equal(
      secondStarted,
      true,
      'the waiter acquired the slot after the first review released it',
    );
  } finally {
    fs.rmSync(firstWorkdir, { recursive: true, force: true });
    fs.rmSync(secondWorkdir, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('sandbox slot timeout is an admission miss, not an immediate review failure', async () => {
  const slotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-slot-timeout-dir-'));
  fs.mkdirSync(path.join(slotDirectory, 'slot-0'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(slotDirectory, 'slot-0', 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      acquiredAt: Date.now(),
      token: 'held',
      processIdentity: `${process.pid}:test`,
    }),
  );
  const workdir = createSandboxWorkdir();
  const runtime = {
    ...DEFAULT_SANDBOX_RUNTIME_OPTIONS,
    maxConcurrentSandboxes: 1,
    slotDirectory,
    slotStaleMs: 60_000,
    slotWaitMs: 30,
  };
  try {
    await assert.rejects(
      runInSandboxWithSpawnForTest(
        { workdir, image: PINNED_IMAGE, command: 'true' },
        (() => fakeChild()) as unknown as typeof spawn,
        runtime,
      ),
      /slot wait timed out.*admission timed out/,
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});
