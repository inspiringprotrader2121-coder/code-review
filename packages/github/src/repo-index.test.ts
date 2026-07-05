import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveRelevantFiles } from './repo-index.js';

function snap(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

test('ranks a file sharing distinctive identifiers above an unrelated one', () => {
  const snapshot = snap({
    'src/changed.ts': 'export function resolveInstallationToken(id) { return signJwtForInstallation(id); }',
    'src/auth.ts': 'export function signJwtForInstallation(id) { return jwt(id); }', // shares a rare identifier
    'src/unrelated.ts': 'export function renderInvoicePdf(order) { return pdf(order); }',
  });
  const out = retrieveRelevantFiles(snapshot, ['src/changed.ts'], { k: 5 });
  assert.equal(out[0].path, 'src/auth.ts');
  assert.ok(!out.some((f) => f.path === 'src/changed.ts'), 'never returns the changed file itself');
});

test('honors the exclude set (imports/dependents already included)', () => {
  const snapshot = snap({
    'src/changed.ts': 'import { helper } from "./helper"; helper();',
    'src/helper.ts': 'export function helper() {}',
    'src/other.ts': 'export function helper() { return 1; }',
  });
  const out = retrieveRelevantFiles(snapshot, ['src/changed.ts'], {
    k: 5,
    exclude: new Set(['src/helper.ts']),
  });
  assert.ok(!out.some((f) => f.path === 'src/helper.ts'), 'excluded file is not returned');
});

test('respects k and clips file content to maxFileBytes', () => {
  const big = 'tenantResolver '.repeat(5000);
  const snapshot = snap({
    'src/changed.ts': 'function tenantResolver() {}',
    'src/a.ts': `tenantResolver ${big}`,
    'src/b.ts': 'tenantResolver()',
    'src/c.ts': 'tenantResolver()',
  });
  const out = retrieveRelevantFiles(snapshot, ['src/changed.ts'], { k: 2, maxFileBytes: 100 });
  assert.equal(out.length, 2);
  assert.ok(out.every((f) => f.content.length <= 100 + 20), 'content clipped to ~maxFileBytes');
});

test('returns nothing when the change shares no identifiers with the repo', () => {
  const snapshot = snap({
    'src/changed.ts': 'const zzqqxx = 1;',
    'src/a.ts': 'export function completelyDifferentThing() {}',
  });
  const out = retrieveRelevantFiles(snapshot, ['src/changed.ts'], { k: 5 });
  assert.equal(out.length, 0);
});

test('ignores non-code files', () => {
  const snapshot = snap({
    'src/changed.ts': 'function billingCycle() {}',
    'README.md': 'billingCycle billingCycle billingCycle',
    'src/a.ts': 'billingCycle()',
  });
  const out = retrieveRelevantFiles(snapshot, ['src/changed.ts'], { k: 5 });
  assert.ok(out.every((f) => f.path.endsWith('.ts')), 'only code files are candidates');
});
