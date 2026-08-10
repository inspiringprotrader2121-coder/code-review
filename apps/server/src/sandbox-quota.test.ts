import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertPrivateAgentDirectory,
  assertWorkdirWithinQuota,
  measureWorkdirBytes,
  readSandboxOutput,
  removePrivateSandboxFile,
} from './sandbox.js';
import { isVerificationEnabled } from './verify-gate.js';
import { formatRuntimeEvidence, type RuntimeVerifyResult } from './runtime-verify.js';
import { testServerConfig } from './bootstrap/test-config.js';

test('assertWorkdirWithinQuota fails when workdir exceeds the budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-quota-'));
  try {
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(8_000));
    assert.ok(measureWorkdirBytes(dir) >= 8_000);
    assert.throws(() => assertWorkdirWithinQuota(dir, 4_000), /disk quota/);
    assert.equal(assertWorkdirWithinQuota(dir, 20_000), measureWorkdirBytes(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex host output never follows a container-replaced private-directory symlink', () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-rverify-output-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-output-target-'));
  fs.chmodSync(workdir, 0o700);
  fs.chmodSync(outside, 0o700);
  const outsideFile = path.join(outside, 'last-message-deadbeef.txt');
  const output = path.join(workdir, '.orvex-agentic', 'last-message-deadbeef.txt');
  try {
    const agentDir = assertPrivateAgentDirectory(workdir);
    fs.rmSync(agentDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'must remain', { mode: 0o600 });
    fs.symlinkSync(outside, agentDir);

    assert.equal(readSandboxOutput(workdir, output), '');
    removePrivateSandboxFile(workdir, output);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'must remain');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('isVerificationEnabled cannot be disabled by environment in production', () => {
  const durableStore = path.join(os.tmpdir(), 'orvex-verify-config-test.db');
  assert.equal(
    isVerificationEnabled(
      testServerConfig({
        NODE_ENV: 'production',
        ORVEX_ENV: 'production',
        STORE_PATH: durableStore,
        ORVEX_VERIFY: '0',
      }),
    ),
    true,
  );
  assert.equal(
    isVerificationEnabled(
      testServerConfig({
        NODE_ENV: 'production',
        ORVEX_ENV: 'production',
        STORE_PATH: durableStore,
        ORVEX_VERIFY: '0',
        ORVEX_VERIFY_FORCE_OFF: '1',
      }),
    ),
    true,
  );
  assert.equal(isVerificationEnabled(testServerConfig({ ORVEX_VERIFY: '0' })), false);
  assert.equal(isVerificationEnabled(testServerConfig({ ORVEX_VERIFY: undefined })), true);
});

test('formatRuntimeEvidence escapes backticks in fenced output', () => {
  const res: RuntimeVerifyResult = {
    ran: true,
    steps: [
      {
        name: 'test',
        command: 'npm run test',
        ok: false,
        timedOut: false,
        durationMs: 1000,
        output: 'fail\n```\nrm -rf /\n```\nmore',
      },
    ],
  };
  const msg = formatRuntimeEvidence(res)!;
  assert.ok(!msg.includes('```\nrm -rf'), 'must not leave a raw fence break in output');
  assert.match(msg, /fail/);
});
