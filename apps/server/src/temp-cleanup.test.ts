import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupAbandonedAgentCheckouts } from './temp-cleanup.js';

test('startup cleanup removes only old agent checkouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-cleanup-test-'));
  try {
    const oldDir = path.join(root, 'orvex-repo-old');
    const freshDir = path.join(root, 'orvex-repo-fresh');
    const runtimeVerifyDir = path.join(root, 'orvex-rverify-old');
    // A live sandbox container mount uses the `orvex-rv-` prefix — the sweeper
    // must NEVER touch it.
    const sandboxContainerDir = path.join(root, 'orvex-rv-live');
    const codexDir = path.join(root, 'orvex-codex-old');
    const unrelated = path.join(root, 'other-temp');
    fs.mkdirSync(oldDir);
    fs.mkdirSync(freshDir);
    fs.mkdirSync(runtimeVerifyDir);
    fs.mkdirSync(sandboxContainerDir);
    fs.mkdirSync(codexDir);
    fs.mkdirSync(unrelated);
    const now = Date.now();
    for (const oldEntry of [oldDir, runtimeVerifyDir, sandboxContainerDir, codexDir]) {
      fs.utimesSync(oldEntry, new Date(now - 2_000), new Date(now - 2_000));
    }
    fs.utimesSync(freshDir, new Date(now), new Date(now));

    assert.equal(cleanupAbandonedAgentCheckouts(root, 1_000, now), 3);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(runtimeVerifyDir), false);
    assert.equal(fs.existsSync(codexDir), false);
    // old but reserved for a live container — preserved.
    assert.equal(fs.existsSync(sandboxContainerDir), true);
    assert.equal(fs.existsSync(freshDir), true);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
