import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkImportBindings, enumerateExports, extractNamedImports } from './import-check.js';

const files = (map: Record<string, string>) => async (path: string) => map[path] ?? null;

test('THE PR93 BUG: CJS destructure of a name the target never exports → P1 finding', async () => {
  const findings = await checkImportBindings(
    [
      {
        path: 'backend/scripts/restore-master-pitr.js',
        content: `const { isR2Configured, getFileFromR2, listObjectsFromR2 } = require('../src/lib/r2-storage');\n`,
      },
    ],
    files({
      'backend/src/lib/r2-storage.js': `
async function downloadFileFromR2() {}
async function listObjectsFromR2() {}
function isR2Configured() { return true; }
module.exports = {
  downloadFileFromR2,
  isR2Configured,
  listObjectsFromR2,
};`,
    }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'P1');
  assert.equal(findings[0].ruleId, 'import-export-mismatch');
  assert.equal(findings[0].sourceTier, 'deterministic');
  assert.match(findings[0].message, /getFileFromR2/);
  assert.match(findings[0].message, /downloadFileFromR2/); // shows what IS available
  assert.equal(findings[0].line, 1);
});

test('all imported names present → no findings', async () => {
  const findings = await checkImportBindings(
    [{ path: 'a.js', content: `const { x, y: alias } = require('./b');\n` }],
    files({ 'b.js': `exports.x = 1;\nexports.y = 2;\n` }),
  );
  assert.equal(findings.length, 0);
});

test('ESM named import missing from ESM module → finding; alias uses the exported name', async () => {
  const findings = await checkImportBindings(
    [{ path: 'src/a.ts', content: `import { real, ghost as g } from './b.js';\n` }],
    files({ 'src/b.ts': `export function real() {}\nexport const other = 1;\n` }),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /ghost/);
});

test('export list aliases count as the EXPORTED name', async () => {
  const findings = await checkImportBindings(
    [{ path: 'a.js', content: `import { publicName } from './b';\n` }],
    files({ 'b.js': `function internalName() {}\nexport { internalName as publicName };\n` }),
  );
  assert.equal(findings.length, 0);
});

test('named and namespace re-exports are treated as non-enumerable, not missing exports', () => {
  for (const target of [
    `export { publicName } from './source.js';\n`,
    `export { internalName as publicName } from './source.js';\n`,
    `export * as namespace from './source.js';\n`,
  ]) {
    assert.equal(
      enumerateExports(target),
      null,
      `must not guess through re-export: ${target.trim()}`,
    );
  }
});

test('spread in module.exports → un-enumerable, stays silent even on a missing name', async () => {
  const findings = await checkImportBindings(
    [{ path: 'a.js', content: `const { definitelyMissing } = require('./b');\n` }],
    files({ 'b.js': `module.exports = { ...require('./base'), extra: 1 };\n` }),
  );
  assert.equal(findings.length, 0);
});

test('module.exports = someIdentifier and export * → un-enumerable, silent', async () => {
  for (const target of [
    `const api = buildApi();\nmodule.exports = api;\n`,
    `export * from './other';\nexport const z = 1;\n`,
  ]) {
    const findings = await checkImportBindings(
      [
        {
          path: 'a.js',
          content: `const { missing } = require('./b');\nimport { missing2 } from './b';\n`,
        },
      ],
      files({ 'b.js': target }),
    );
    assert.equal(findings.length, 0, `should be silent for: ${target.slice(0, 40)}`);
  }
});

test('non-relative (package) imports are ignored', async () => {
  const findings = await checkImportBindings(
    [
      {
        path: 'a.js',
        content: `const { whatever } = require('express');\nimport { thing } from 'zod';\n`,
      },
    ],
    files({}),
  );
  assert.equal(findings.length, 0);
});

test('resolves ./dir to dir/index.js and .js specifier to .ts source', async () => {
  const findings = await checkImportBindings(
    [
      { path: 'src/a.js', content: `const { fromIndex } = require('./lib');\n` },
      { path: 'src/c.ts', content: `import { fromTs, missingInTs } from './d.js';\n` },
    ],
    files({
      'src/lib/index.js': `exports.fromIndex = 1;\n`,
      'src/d.ts': `export const fromTs = 1;\n`,
    }),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /missingInTs/);
});

test('type-only imports are skipped (vanish at runtime)', async () => {
  const findings = await checkImportBindings(
    [{ path: 'a.ts', content: `import type { GhostType } from './b.js';\n` }],
    files({ 'b.ts': `export const real = 1;\n` }),
  );
  assert.equal(findings.length, 0);
});

test('unresolvable target module → silent (no guessing)', async () => {
  const findings = await checkImportBindings(
    [{ path: 'a.js', content: `const { x } = require('./nowhere');\n` }],
    files({}),
  );
  assert.equal(findings.length, 0);
});

test('THE PR103 FALSE POSITIVE: exports preceded by // comments are still captured', async () => {
  // A comment line before an export inside module.exports made the parser drop
  // that export → false "isJobsLeader is not exported" P1. Both isJobsLeader
  // and recordJobStatus sit under comment lines here.
  const findings = await checkImportBindings(
    [
      {
        path: 'a.test.js',
        content: `const { isJobsLeader, recordJobStatus } = require('./cronManager');\n`,
      },
    ],
    files({
      'cronManager.js': `
module.exports = {
  getIntervalMs,
  // C12 leader election — consumed by jobs/notifications.js and tests.
  isJobsLeader,
  canRunJobs,
  /* block comment
     spanning lines */
  recordJobStatus,
  withOverlapGuard,
};`,
    }),
  );
  assert.equal(findings.length, 0, 'commented exports must be recognized, not flagged as missing');
});

test('enumerateExports still flags a genuinely-absent name when comments are present', async () => {
  const findings = await checkImportBindings(
    [{ path: 'a.js', content: `const { reallyMissing } = require('./b');\n` }],
    files({ 'b.js': `module.exports = {\n  // a comment\n  present,\n};` }),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /reallyMissing/);
});

test('enumerateExports handles object literal with methods, getters and nested braces', () => {
  const names = enumerateExports(`
module.exports = {
  plain,
  renamed: internal,
  async doWork(a, b) { if (a) { return { x: 1 }; } },
  get lazy() { return 1; },
};`);
  assert.ok(names);
  assert.deepEqual([...names!].sort(), ['doWork', 'lazy', 'plain', 'renamed']);
});

test('extractNamedImports reports the correct 1-based line', () => {
  const imports = extractNamedImports(`// header\n// more\nconst { a } = require('./x');\n`);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].line, 3);
});
