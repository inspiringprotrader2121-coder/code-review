import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessHostAdmission } from './host-admission.js';

test('host admission is open when thresholds are disabled', () => {
  const decision = assessHostAdmission({
    minAvailableMemoryBytes: 0,
    minAvailableDiskBytes: 0,
  });
  assert.equal(decision.ok, true);
});

test('host admission rejects when the memory floor exceeds available RAM', () => {
  const decision = assessHostAdmission({
    minAvailableMemoryBytes: Number.MAX_SAFE_INTEGER,
    minAvailableDiskBytes: 0,
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason ?? '', /available memory/);
});

test('host admission rejects when the disk floor exceeds available space', () => {
  const decision = assessHostAdmission({
    minAvailableMemoryBytes: 0,
    minAvailableDiskBytes: Number.MAX_SAFE_INTEGER,
    diskPath: process.cwd(),
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason ?? '', /available disk/);
});
