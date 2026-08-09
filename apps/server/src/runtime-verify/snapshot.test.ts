import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectPackageManager,
  detectSteps,
  isSafeSnapshotPath,
  isOfflineCacheMiss,
} from './snapshot.js';

test('runtime snapshot paths fail closed for absolute, traversal, empty, and native separator paths', () => {
  for (const candidate of [
    '',
    '/etc/passwd',
    '../escape',
    'dir/../escape',
    'dir\\escape',
    'dir//file',
  ]) {
    assert.equal(isSafeSnapshotPath(candidate), false, candidate);
  }
  assert.equal(isSafeSnapshotPath('packages/review/package.json'), true);
  assert.equal(isSafeSnapshotPath('.github/workflows/ci.yml'), true);
});

test('runtime verification selects offline installs with lifecycle scripts disabled', () => {
  const pnpm = detectPackageManager(new Map([['pnpm-lock.yaml', 'lockfileVersion: 9']]));
  const yarn = detectPackageManager(new Map([['yarn.lock', '']]));
  const npm = detectPackageManager(new Map());

  assert.match(pnpm.installCmd, /pnpm install --offline --frozen-lockfile --ignore-scripts/);
  assert.match(yarn.installCmd, /yarn install --offline --frozen-lockfile --ignore-scripts/);
  assert.match(npm.installCmd, /npm ci --offline --ignore-scripts/);
  for (const command of [pnpm.installCmd, yarn.installCmd, npm.installCmd]) {
    assert.match(command, /NPM_CONFIG_USERCONFIG=\/dev\/null/);
    assert.match(command, /YARN_ENABLE_NETWORK=0/);
  }
});

test('runtime verification only executes declared typecheck/build and test scripts', () => {
  assert.deepEqual(
    detectSteps(
      JSON.stringify({ scripts: { build: 'vite build', test: 'node --test', lint: 'eslint .' } }),
      'npm',
    ),
    [
      { name: 'build', command: 'npm run build' },
      { name: 'test', command: 'npm run test' },
    ],
  );
  assert.deepEqual(detectSteps('{ malformed', 'pnpm'), []);
});

test('offline cache misses are recognized without classifying ordinary failures as cache misses', () => {
  assert.equal(isOfflineCacheMiss('ERR_PNPM_NO_OFFLINE_TARBALL missing package'), true);
  assert.equal(isOfflineCacheMiss("Can't make a request in offline mode"), true);
  assert.equal(isOfflineCacheMiss('TypeError: invalid package-lock.json'), false);
});
