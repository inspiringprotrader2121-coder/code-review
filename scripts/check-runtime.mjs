#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nodeVersionFile = path.join(root, '.node-version');
const required = manifest.engines?.node;
const match =
  typeof required === 'string' ? /^>=([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(required) : null;

if (!match) {
  throw new Error('package.json engines.node must be an exact minimum such as >=22.13.0');
}

if (!fs.existsSync(nodeVersionFile)) {
  throw new Error(
    '.node-version must pin the Node.js line used by CI and fresh-Linux verification',
  );
}
const pinned = fs.readFileSync(nodeVersionFile, 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
  throw new Error('.node-version must contain an exact Node.js semver version');
}

const actual = process.versions.node.split('.').map(Number);
const minimum = match.slice(1).map(Number);
const pinnedParts = pinned.split('.').map(Number);
const meetsMinimum =
  actual[0] > minimum[0] ||
  (actual[0] === minimum[0] &&
    (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2])));

if (!meetsMinimum) {
  throw new Error(`Node.js ${required} is required; running ${process.versions.node}`);
}

const pinMeetsMinimum =
  pinnedParts[0] > minimum[0] ||
  (pinnedParts[0] === minimum[0] &&
    (pinnedParts[1] > minimum[1] ||
      (pinnedParts[1] === minimum[1] && pinnedParts[2] >= minimum[2])));
if (!pinMeetsMinimum) {
  throw new Error(`.node-version ${pinned} does not satisfy package.json engines.node ${required}`);
}

console.log(
  `runtime check passed: Node.js ${process.versions.node} satisfies ${required}; CI pin is ${pinned}`,
);
