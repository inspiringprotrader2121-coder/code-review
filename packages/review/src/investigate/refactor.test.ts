import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ToolCallSchema } from './contracts.js';
import { runInvestigateTool } from './dispatcher.js';
import { clip, redactGrepOutput } from './output.js';
import { isSensitiveRepoPath, relativeToRoot, resolveUnderRoot } from './policy.js';

test('tool schema admits only the documented read-only tool shapes', () => {
  assert.equal(
    ToolCallSchema.safeParse({ name: 'read_file', path: 'src/a.ts', offset: 0 }).success,
    true,
  );
  assert.equal(ToolCallSchema.safeParse({ name: 'write_file', path: 'src/a.ts' }).success, false);
  assert.equal(ToolCallSchema.safeParse({ name: 'grep', pattern: 'x'.repeat(401) }).success, false);
});

test('policy keeps relative paths, sensitive names, and symlinks confined', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-investigate-policy-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-investigate-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'source.ts'), 'export const safe = true;\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not reachable');
    fs.symlinkSync(outside, path.join(root, 'nested', 'escape'));

    const source = resolveUnderRoot(root, 'nested/source.ts');
    assert.ok(source);
    assert.equal(relativeToRoot(root, source), 'nested/source.ts');
    assert.equal(resolveUnderRoot(root, 'nested/escape/secret.txt'), null);
    assert.equal(isSensitiveRepoPath('nested/.env.production'), true);
    assert.equal(isSensitiveRepoPath('nested/server.pem'), true);
    assert.equal(isSensitiveRepoPath('nested/source.ts'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('output helpers redact before clipping and preserve grep location data', () => {
  const output = redactGrepOutput('config.yml:12:secret_key_base: supersecretvalue1234567890');
  assert.match(output, /^config\.yml:12:/);
  assert.doesNotMatch(output, /supersecretvalue1234567890/);
  assert.match(clip('abcdefgh', 4), /truncated/);
});

test('dispatcher remains read-only and rejects sensitive paths across tool kinds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-investigate-dispatch-'));
  try {
    fs.writeFileSync(path.join(root, '.env.local'), 'API_KEY=privatevalue123456789\n');
    const read = await runInvestigateTool(root, { name: 'read_file', path: '.env.local' }, 1_000);
    const grep = await runInvestigateTool(
      root,
      { name: 'grep', pattern: 'API_KEY', path: '.env.local' },
      1_000,
    );
    assert.match(read, /sensitive file access is not available/);
    assert.match(grep, /sensitive file access is not available/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
