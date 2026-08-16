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

test('a full sandbox host waits for a slot instead of failing the review immediately', async () => {
  const slotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-sandbox-slots-test-'));
  const workdirs = [createSandboxWorkdir(), createSandboxWorkdir()];
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
      }, 40);
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
    maxConcurrentSandboxes: 1,
    slotDirectory,
    slotStaleMs: 1,
    slotWaitMs: 2_000,
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
    assert.equal(peak, 1, 'the second review waited for the only host slot');
    assert.ok(results.every((result) => result.exitCode === 0));
  } finally {
    for (const workdir of workdirs) fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});
