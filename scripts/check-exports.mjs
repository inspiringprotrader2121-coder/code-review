#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const exportTargets = [];
for (const group of ['apps', 'packages']) {
  const groupDir = path.join(root, group);
  for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
    const manifestPath = path.join(groupDir, entry.name, 'package.json');
    if (!entry.isDirectory() || !fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.name || !manifest.exports) continue;
    if (typeof manifest.exports === 'string') {
      exportTargets.push({
        label: manifest.name,
        file: path.resolve(path.dirname(manifestPath), manifest.exports),
      });
      continue;
    }
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (typeof target !== 'string') continue;
      exportTargets.push({
        label: subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
        file: path.resolve(path.dirname(manifestPath), target),
      });
    }
  }
}

const failures = [];
for (const target of exportTargets.sort((a, b) => a.label.localeCompare(b.label))) {
  try {
    await import(pathToFileURL(target.file).href);
  } catch (error) {
    failures.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(`export smoke check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`export smoke check passed for ${exportTargets.length} workspace export(s)`);
}
