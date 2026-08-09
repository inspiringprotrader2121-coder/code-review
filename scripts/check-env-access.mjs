#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const baselinePath = path.join(root, 'scripts', 'env-access-baseline.json');
const writeBaseline = process.argv.includes('--write-baseline');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'dist' || entry.name === 'node_modules' ? [] : walk(full);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)
      ? [full]
      : [];
  });
}

function isApproved(relative) {
  return (
    relative.startsWith('packages/config/src/') ||
    relative.startsWith('apps/server/src/bootstrap/') ||
    relative.startsWith('apps/cli/src/') ||
    relative.startsWith('apps/eval/src/')
  );
}

function directEnvReads(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let count = 0;
  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    )
      count += 1;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return count;
}

const current = {};
for (const group of ['apps', 'packages']) {
  for (const file of walk(path.join(root, group))) {
    const relative = path.relative(root, file);
    if (isApproved(relative)) continue;
    const count = directEnvReads(file);
    if (count > 0) current[relative] = count;
  }
}

if (writeBaseline) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o644 });
  console.log(`wrote environment-access baseline for ${Object.keys(current).length} file(s)`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const regressions = [];
for (const [file, count] of Object.entries(current)) {
  const allowed = Number(baseline[file] ?? 0);
  if (count > allowed) regressions.push(`${file}: ${count} direct read(s), baseline ${allowed}`);
}
if (regressions.length > 0) {
  console.error('direct process.env access increased outside configuration/bootstrap:');
  for (const regression of regressions) console.error(`- ${regression}`);
  process.exitCode = 1;
} else {
  const reads = Object.values(current).reduce((sum, count) => sum + count, 0);
  console.log(`environment-access ratchet passed: ${reads} legacy direct read(s), no increase`);
}
