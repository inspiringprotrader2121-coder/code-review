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

test('length normalization: a giant file cannot dominate by sheer token count', () => {
  const rareToken = 'quixoticBillingReconciler';
  // A huge file that happens to mention the rare token once, buried in thousands
  // of unrelated identifiers, vs a small file whose whole content IS about it.
  const giant = `${rareToken}();\n` + Array.from({ length: 3000 }, (_, i) => `const unrelatedThing${i} = ${i};`).join('\n');
  const snapshot = snap({
    'src/changed.ts': `function ${rareToken}() {}`,
    'src/giant.ts': giant,
    'src/focused.ts': `export function call${rareToken[0].toUpperCase()}${rareToken.slice(1)}() { return ${rareToken}(); }`,
  });
  const out = retrieveRelevantFiles(snapshot, ['src/changed.ts'], { k: 5 });
  assert.equal(out[0].path, 'src/focused.ts', 'the small highly-relevant file outranks the giant incidental match');
});

test('a changed file MISSING from the snapshot falls back to path-derived query tokens', () => {
  const snapshot = snap({
    // 'src/billing/invoice.ts' is the changed file but is NOT in the snapshot
    // (dropped for size) — its path must still seed the query.
    'src/billing/invoiceEmail.ts': 'export function sendInvoiceEmail() { return 1; }',
    'src/unrelated.ts': 'export function renderLandingPage() { return 1; }',
  });
  const out = retrieveRelevantFiles(snapshot, ['src/billing/invoice.ts'], { k: 5 });
  assert.equal(out[0]?.path, 'src/billing/invoiceEmail.ts', 'path tokens (billing/invoice) find the sibling file');
});

test('SQL/shell keywords are stopwords — keyword overlap alone scores nothing', () => {
  const snapshot = snap({
    'db/changed.sql': 'SELECT id FROM users WHERE active = 1 LIMIT 10;',
    'db/other.sql': 'SELECT id FROM orders WHERE paid = 1 LIMIT 10;',
    'db/related.sql': 'SELECT id FROM users_preferences WHERE user_id = 1;',
  });
  const out = retrieveRelevantFiles(snapshot, ['db/changed.sql'], { k: 5 });
  assert.ok(
    !out.some((f) => f.path === 'db/other.sql'),
    'two migrations sharing only SELECT/WHERE/LIMIT must not match',
  );
  assert.equal(out[0]?.path, 'db/related.sql', 'a real shared identifier (users) still ranks');
});
