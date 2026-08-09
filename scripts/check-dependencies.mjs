#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const workspaceGroups = ['apps', 'packages'];
const manifests = [];

for (const group of workspaceGroups) {
  const groupDir = path.join(root, group);
  for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(groupDir, entry.name, 'package.json');
    if (fs.existsSync(file)) manifests.push(file);
  }
}
manifests.push(path.join(root, 'package.json'));

const seen = new Map();
const errors = [];
for (const manifestFile of manifests) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith('@orvex-review/')) {
        if (range !== 'workspace:*') {
          errors.push(`${path.relative(root, manifestFile)}: ${name} must use workspace:*`);
        }
        continue;
      }
      const record = seen.get(name) ?? [];
      record.push({ file: path.relative(root, manifestFile), field, range });
      seen.set(name, record);
    }
  }
}

for (const [name, records] of seen) {
  const ranges = new Set(records.map((record) => record.range));
  if (ranges.size > 1) {
    errors.push(
      `${name} has inconsistent ranges: ${records.map((record) => `${record.file} (${record.range})`).join(', ')}`,
    );
  }
}

if (errors.length > 0) {
  console.error(`dependency policy check failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`dependency policy check passed for ${manifests.length} manifests`);
}
