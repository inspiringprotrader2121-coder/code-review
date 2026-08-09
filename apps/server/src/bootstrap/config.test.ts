import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackHost, loadServerRuntimeConfig } from './config.js';

test('server runtime config has bounded production defaults', () => {
  assert.deepEqual(loadServerRuntimeConfig({}), {
    host: '0.0.0.0',
    port: 8787,
    allowPublicNoLogin: false,
    staleRunMs: 15 * 60_000,
    codexStatusFile: '/home/orvex/orvex-data/codex-auth-status',
  });
});

test('server runtime config clamps malformed operational values', () => {
  assert.deepEqual(
    loadServerRuntimeConfig({
      HOST: ' 127.0.0.1 ',
      PORT: '99999',
      ORVEX_ALLOW_PUBLIC_NOLOGIN: '1',
      ORVEX_RUNNING_STALE_MS: '10',
      ORVEX_CODEX_STATUS_FILE: '/tmp/codex-status',
    }),
    {
      host: '127.0.0.1',
      port: 65_535,
      allowPublicNoLogin: true,
      staleRunMs: 60_000,
      codexStatusFile: '/tmp/codex-status',
    },
  );
});

test('loopback binding recognition is explicit', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});
