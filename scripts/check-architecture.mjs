#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const workspaceDirs = ['apps', 'packages'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs']);
const errors = [];
const workspacePackages = new Map();

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

function packageDirectories() {
  return workspaceDirs.flatMap((group) => {
    const groupDir = path.join(root, group);
    return fs
      .readdirSync(groupDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && fs.existsSync(path.join(groupDir, entry.name, 'package.json')),
      )
      .map((entry) => path.join(groupDir, entry.name));
  });
}

function importedWorkspacePackages(source) {
  const found = new Set();
  const pattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"](@orvex-review\/[^/'"]+)/g;
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ownerFor(file) {
  for (const [name, directory] of workspacePackages) {
    if (isWithin(directory, file)) return name;
  }
  return undefined;
}

const dependencyGraph = new Map();
for (const packageDir of packageDirectories()) {
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  workspacePackages.set(manifest.name, packageDir);
  dependencyGraph.set(manifest.name, new Set());
}

for (const packageDir of packageDirectories()) {
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const srcDir = path.join(packageDir, 'src');
  if (!fs.existsSync(srcDir)) continue;
  for (const file of walk(srcDir)) {
    const relative = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const dependency of importedWorkspacePackages(source)) {
      if (dependency !== manifest.name && !declared.has(dependency)) {
        errors.push(`${relative}: imports undeclared workspace dependency ${dependency}`);
      }
      if (dependency !== manifest.name && workspacePackages.has(dependency)) {
        dependencyGraph.get(manifest.name).add(dependency);
      }
    }
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (/^@orvex-review\/[^/]+\/src\//.test(specifier)) {
        errors.push(`${relative}: workspace private source import ${specifier}`);
      }
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      const owner = ownerFor(resolved);
      if (owner && owner !== manifest.name && owner.startsWith('@orvex-review/')) {
        errors.push(`${relative}: cross-workspace relative source import ${specifier}`);
      }
    }
  }
}

const visiting = new Set();
const visited = new Set();
function visit(name, trail) {
  if (visiting.has(name)) {
    errors.push(`workspace dependency cycle: ${[...trail, name].join(' -> ')}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of dependencyGraph.get(name) ?? []) visit(dependency, [...trail, name]);
  visiting.delete(name);
  visited.add(name);
}
for (const name of dependencyGraph.keys()) visit(name, []);

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 22) {
  errors.push(`Node.js 22 or newer is required; running ${process.versions.node}`);
}

if (errors.length > 0) {
  console.error(`architecture check failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    'architecture check passed: workspace dependencies, private imports, and Node version',
  );
}
