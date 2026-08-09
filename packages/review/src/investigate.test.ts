import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSafeGlob,
  isSafeGrepPattern,
  resolveUnderRoot,
  runInvestigateTool,
  extractDeletedSymbols,
} from './investigate.js';

test('resolveUnderRoot confines paths under checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.writeFileSync(path.join(root, 'ok.ts'), ' console.log(1)\n');
    fs.mkdirSync(path.join(root, 'src'));
    assert.ok(resolveUnderRoot(root, 'ok.ts')?.endsWith('ok.ts'));
    assert.ok(resolveUnderRoot(root, 'src'));
    assert.equal(resolveUnderRoot(root, '../outside'), null);
    assert.equal(resolveUnderRoot(root, '/etc/passwd'), null);
    assert.equal(resolveUnderRoot(root, 'src/../../outside'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveUnderRoot refuses symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-out-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'link'));
    assert.equal(resolveUnderRoot(root, 'link/secret.txt'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('grep pattern / glob safety', () => {
  assert.equal(isSafeGrepPattern('fooBar'), true);
  assert.equal(isSafeGrepPattern('--help'), false);
  assert.equal(isSafeGrepPattern(''), false);
  assert.equal(isSafeGlob('*.ts'), true);
  assert.equal(isSafeGlob('--glob'), false);
});

test('runInvestigateTool list_dir + read_file stay sandboxed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.writeFileSync(path.join(root, 'pkg/a.ts'), 'export const x = 1;\n');
    const listing = await runInvestigateTool(root, { name: 'list_dir', path: 'pkg' }, 8_000);
    assert.match(listing, /a\.ts/);
    const body = await runInvestigateTool(
      root,
      { name: 'read_file', path: 'pkg/a.ts', offset: 0, limit: 5 },
      8_000,
    );
    assert.match(body, /export const x/);
    const escaped = await runInvestigateTool(
      root,
      { name: 'read_file', path: '../etc/passwd' },
      8_000,
    );
    assert.match(escaped, /ERROR/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read_file redacts secrets even with line-number prefixes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.writeFileSync(path.join(root, 'cfg.yml'), 'secret_key_base: supersecretvalue1234567890\n');
    const body = await runInvestigateTool(root, { name: 'read_file', path: 'cfg.yml' }, 8_000);
    assert.doesNotMatch(body, /supersecretvalue1234567890/);
    assert.match(body, /1\|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('caller and test lookup tools are noninteractive, checkout-confined, and useful', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(
      path.join(root, 'src', 'widget.ts'),
      'export function renderWidget() { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(root, 'src', 'consumer.ts'),
      "import { renderWidget } from './widget';\nrenderWidget();\n",
    );
    fs.writeFileSync(
      path.join(root, 'test', 'widget.test.ts'),
      "import { renderWidget } from '../src/widget';\nrenderWidget();\n",
    );

    const callers = await runInvestigateTool(
      root,
      { name: 'find_callers', symbol: 'renderWidget', path: 'src' },
      8_000,
    );
    assert.match(callers, /consumer\.ts/);
    const tests = await runInvestigateTool(
      root,
      { name: 'find_tests', path: 'src/widget.ts' },
      8_000,
    );
    assert.match(tests, /widget\.test\.ts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grep redacts matching secrets and sensitive paths are refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-inv-'));
  try {
    fs.writeFileSync(
      path.join(root, 'config.yml'),
      'secret_key_base: supersecretvalue1234567890\n',
    );
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=hiddenvalue1234567890\n');
    const grep = await runInvestigateTool(
      root,
      { name: 'grep', pattern: 'secret_key_base' },
      8_000,
    );
    assert.doesNotMatch(grep, /supersecretvalue1234567890/);
    assert.match(grep, /REDACTED/);
    const env = await runInvestigateTool(root, { name: 'read_file', path: '.env' }, 8_000);
    assert.match(env, /sensitive file access is not available/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extractDeletedSymbols pulls renamed/removed functions from diffs', () => {
  const symbols = extractDeletedSymbols([
    {
      filename: 'a.ts',
      status: 'modified',
      patch: [
        '@@ -1,5 +1,5 @@',
        '-export async function releaseCoupon(id) {',
        '+export async function releaseCouponV2(id) {',
        '-const checkOwnership = (row) => {',
        '+const checkOwnership = (row, tenantId) => {',
      ].join('\n'),
    },
  ]);
  assert.ok(symbols.includes('releaseCoupon'));
  assert.ok(symbols.includes('checkOwnership'));
});

test('extractDeletedSymbols includes fully deleted files', () => {
  const symbols = extractDeletedSymbols([
    {
      filename: 'gone.ts',
      status: 'removed',
      patch: [
        '@@ -1,3 +0,0 @@',
        '-export function guardTenant(row) {',
        '-  return row.tenantId;',
        '-}',
      ].join('\n'),
    },
  ]);
  assert.ok(symbols.includes('guardTenant'));
});
