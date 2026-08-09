#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const failures = [];
const targets = [];

function addCompiledTarget(label, packageDirectory, target, importable, requireTypes) {
  if (typeof target !== 'string' || !target.startsWith('./dist/')) {
    failures.push(`${label}: entrypoint must target compiled ./dist output`);
    return;
  }
  targets.push({
    label,
    file: path.join(packageDirectory, target),
    types: requireTypes ? path.join(packageDirectory, target.replace(/\.js$/, '.d.ts')) : undefined,
    importable,
  });
}

for (const group of ['apps', 'packages']) {
  const groupDir = path.join(root, group);
  for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(groupDir, entry.name, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const packageDirectory = path.join(groupDir, entry.name);
    const exports = manifest.exports ?? {};
    const bins =
      typeof manifest.bin === 'string'
        ? { [manifest.name ?? entry.name]: manifest.bin }
        : (manifest.bin ?? {});
    if (Object.keys(exports).length === 0 && Object.keys(bins).length === 0) {
      failures.push(
        `${manifest.name ?? manifestPath}: every workspace app/package must declare exports or a bin entrypoint`,
      );
    }
    if (!Array.isArray(manifest.files) || !manifest.files.includes('dist')) {
      failures.push(`${manifest.name ?? manifestPath}: files must include dist`);
    }
    if (manifest.main || manifest.types) {
      const rootExport = exports['.'];
      const rootTarget =
        typeof rootExport === 'string' ? rootExport : (rootExport?.import ?? rootExport?.default);
      if (!rootTarget) {
        failures.push(
          `${manifest.name ?? manifestPath}: main/types require an explicit root export`,
        );
      } else {
        if (manifest.main && manifest.main !== rootTarget)
          failures.push(`${manifest.name}: main must match the root export`);
        const rootTypes = typeof rootExport === 'object' ? rootExport.types : undefined;
        const expectedTypes = rootTarget.replace(/\.js$/, '.d.ts');
        if (manifest.types && manifest.types !== (rootTypes ?? expectedTypes)) {
          failures.push(`${manifest.name}: types must match the root export declaration output`);
        }
      }
    }
    for (const [subpath, target] of Object.entries(exports)) {
      const importTarget = typeof target === 'string' ? target : (target.import ?? target.default);
      addCompiledTarget(
        `${manifest.name}${subpath === '.' ? '' : subpath.slice(1)}`,
        packageDirectory,
        importTarget,
        true,
        true,
      );
    }
    for (const [name, target] of Object.entries(bins)) {
      addCompiledTarget(`${manifest.name} bin ${name}`, packageDirectory, target, false, false);
    }
  }
}

for (const target of targets.sort((a, b) => a.label.localeCompare(b.label))) {
  if (!fs.existsSync(target.file)) {
    failures.push(
      `${target.label}: compiled export is missing (${path.relative(root, target.file)})`,
    );
    continue;
  }
  if (target.types && !fs.existsSync(target.types)) {
    failures.push(
      `${target.label}: declaration output is missing (${path.relative(root, target.types)})`,
    );
  }
  if (target.importable) {
    try {
      await import(pathToFileURL(target.file).href);
    } catch (error) {
      failures.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const syntax = spawnSync(process.execPath, ['--check', target.file], { encoding: 'utf8' });
    if (syntax.status !== 0)
      failures.push(
        `${target.label}: ${syntax.stderr || syntax.stdout || 'compiled bin syntax check failed'}`,
      );
  }
}

for (const group of ['apps', 'packages']) {
  const groupDir = path.join(root, group);
  for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dist = path.join(groupDir, entry.name, 'dist');
    if (!fs.existsSync(dist)) continue;
    const stack = [dist];
    while (stack.length > 0) {
      const directory = stack.pop();
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, child.name);
        if (child.isDirectory()) stack.push(file);
        else if (/\.test\.(?:js|d\.ts)$/.test(child.name))
          failures.push(
            `${path.relative(root, file)}: test artifact must not be emitted into dist`,
          );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`built export check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`built export check passed for ${targets.length} compiled workspace export(s)`);
}
