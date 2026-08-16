import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runAgainstHeadFiles } from './semgrep-checkout.js';

test('Semgrep receives an isolated PR-head checkout instead of the worker source tree', async () => {
  let observedCwd = '';
  const result = await runAgainstHeadFiles(
    ['src/changed.ts', 'nested/module.py', '../outside.ts', '/absolute.ts', 'bad\\path.ts'],
    async (filename) =>
      ({
        'src/changed.ts': 'export const changed = true;\n',
        'nested/module.py': 'print("head")\n',
      })[filename] ?? null,
    async (paths, cwd) => {
      observedCwd = cwd;
      assert.deepEqual(paths, ['src/changed.ts', 'nested/module.py']);
      assert.equal(await readFile(`${cwd}/src/changed.ts`, 'utf8'), 'export const changed = true;\n');
      assert.equal(await readFile(`${cwd}/nested/module.py`, 'utf8'), 'print("head")\n');
      return 'scanned';
    },
  );

  assert.equal(result, 'scanned');
  assert.equal(existsSync(observedCwd), false);
});

test('an unreadable PR file is skipped rather than falling back to worker files', async () => {
  const result = await runAgainstHeadFiles(
    ['src/readable.ts', 'src/unreadable.ts'],
    async (filename) => {
      if (filename === 'src/unreadable.ts') throw new Error('GitHub blob unavailable');
      return 'export const head = true;\n';
    },
    async (paths) => paths,
  );

  assert.deepEqual(result, ['src/readable.ts']);
});
