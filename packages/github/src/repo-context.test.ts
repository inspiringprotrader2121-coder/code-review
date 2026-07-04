import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelativeImports, resolveImportToTreePath } from './repo-context.js';

test('parseRelativeImports finds relative specifiers across import styles', () => {
  const src = `
import { a } from './utils.js';
import type { B } from '../types';
import * as fs from 'node:fs';
import express from 'express';
export { c } from './c/index.js';
const d = require('../lib/d');
const lazy = await import('./lazy');
`;
  assert.deepEqual(parseRelativeImports(src).sort(), [
    '../lib/d',
    '../types',
    './c/index.js',
    './lazy',
    './utils.js',
  ]);
});

test('resolveImportToTreePath handles extensions, index files, and ESM .js→.ts', () => {
  const tree = new Set([
    'src/routes/auth.ts',
    'src/utils.ts',
    'src/types.ts',
    'src/lib/d.js',
    'src/c/index.ts',
    'src/lazy.tsx',
  ]);
  const from = 'src/routes/auth.ts';
  assert.equal(resolveImportToTreePath(from, '../utils.js', tree), 'src/utils.ts');
  assert.equal(resolveImportToTreePath(from, '../types', tree), 'src/types.ts');
  assert.equal(resolveImportToTreePath(from, '../lib/d', tree), 'src/lib/d.js');
  assert.equal(resolveImportToTreePath(from, '../c/index.js', tree), 'src/c/index.ts');
  assert.equal(resolveImportToTreePath(from, '../lazy', tree), 'src/lazy.tsx');
  assert.equal(resolveImportToTreePath(from, '../missing', tree), null);
});
