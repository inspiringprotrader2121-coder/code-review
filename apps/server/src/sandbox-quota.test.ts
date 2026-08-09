import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWorkdirWithinQuota, measureWorkdirBytes } from './sandbox.js';
import { isVerificationEnabled } from './verify-gate.js';
import { formatRuntimeEvidence, type RuntimeVerifyResult } from './runtime-verify.js';

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

test('isVerificationEnabled cannot be disabled by environment in production', () => {
  const prev = {
    verify: process.env.ORVEX_VERIFY,
    force: process.env.ORVEX_VERIFY_FORCE_OFF,
    node: process.env.NODE_ENV,
    orvex: process.env.ORVEX_ENV,
  };
  try {
    process.env.ORVEX_VERIFY = '0';
    delete process.env.ORVEX_VERIFY_FORCE_OFF;
    process.env.NODE_ENV = 'production';
    delete process.env.ORVEX_ENV;
    assert.equal(isVerificationEnabled(), true);

    process.env.ORVEX_VERIFY_FORCE_OFF = '1';
    assert.equal(isVerificationEnabled(), true);

    delete process.env.NODE_ENV;
    delete process.env.ORVEX_ENV;
    delete process.env.ORVEX_VERIFY_FORCE_OFF;
    assert.equal(isVerificationEnabled(), false);

    delete process.env.ORVEX_VERIFY;
    assert.equal(isVerificationEnabled(), true);
  } finally {
    for (const [k, v] of Object.entries({
      ORVEX_VERIFY: prev.verify,
      ORVEX_VERIFY_FORCE_OFF: prev.force,
      NODE_ENV: prev.node,
      ORVEX_ENV: prev.orvex,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
