#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const documentRoots = [path.join(root, 'README.md'), path.join(root, 'docs')];
const documents = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && entry.name.endsWith('.md')) documents.push(file);
  }
}

for (const candidate of documentRoots) {
  if (fs.statSync(candidate).isDirectory()) walk(candidate);
  else documents.push(candidate);
}

const errors = [];
for (const document of documents) {
  const text = fs.readFileSync(document, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(document), target);
    if (!fs.existsSync(resolved)) {
      errors.push(`${path.relative(root, document)} -> ${target}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`documentation link check failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`documentation link check passed for ${documents.length} document(s)`);
}
