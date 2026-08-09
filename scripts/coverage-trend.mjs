#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const baselineFile = path.join(root, 'scripts', 'coverage-baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');
const reportOnly = process.argv.includes('--report');
const requireBaseline = process.argv.includes('--require-baseline');
const workspaceRoots = ['apps', 'packages'];

if (
  process.argv
    .slice(2)
    .some((argument) => !['--update-baseline', '--report', '--require-baseline'].includes(argument))
) {
  throw new Error('usage: coverage-trend.mjs [--report | --require-baseline | --update-baseline]');
}
if ([updateBaseline, reportOnly, requireBaseline].filter(Boolean).length > 1) {
  throw new Error('coverage modes are mutually exclusive');
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.name.endsWith('.test.ts')) files.push(file);
  }
  return files;
}

function workspaceDirectories() {
  return workspaceRoots.flatMap((group) => {
    const directory = path.join(root, group);
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'package.json')),
      )
      .map((entry) => path.join(directory, entry.name));
  });
}

function parseLcov(text) {
  const counters = {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
  };
  let sourceFiles = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) sourceFiles += 1;
    const match = /^(LF|LH|FNF|FNH|BRF|BRH):(\d+)$/.exec(line);
    if (!match) continue;
    const [, label, value] = match;
    if (label === 'LF') counters.lines.found += Number(value);
    if (label === 'LH') counters.lines.hit += Number(value);
    if (label === 'FNF') counters.functions.found += Number(value);
    if (label === 'FNH') counters.functions.hit += Number(value);
    if (label === 'BRF') counters.branches.found += Number(value);
    if (label === 'BRH') counters.branches.hit += Number(value);
  }
  if (sourceFiles === 0) throw new Error('coverage report contained no source files');
  return {
    sourceFiles,
    minimum: Object.fromEntries(
      Object.entries(counters).map(([name, counter]) => [
        name,
        counter.found === 0 ? 100 : Number(((counter.hit / counter.found) * 100).toFixed(2)),
      ]),
    ),
  };
}

const lcov = [];
for (const workspace of workspaceDirectories()) {
  const tests = walk(path.join(workspace, 'src'));
  if (tests.length === 0) continue;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--experimental-test-coverage',
      '--test-coverage-exclude=**/*.test.ts',
      '--test-coverage-exclude=**/*.test.js',
      '--test-reporter=lcov',
      '--test',
      ...tests,
    ],
    { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
  );
  if (result.status !== 0) {
    process.stderr.write(
      result.stderr || result.stdout || `coverage test failed in ${workspace}\n`,
    );
    process.exit(result.status || 1);
  }
  lcov.push(result.stdout);
}

const report = parseLcov(lcov.join('\n'));
const totals = report.minimum;
if (updateBaseline) {
  if (process.env.CI)
    throw new Error('coverage baselines may only be updated deliberately outside CI');
  fs.writeFileSync(
    baselineFile,
    `${JSON.stringify({ schemaVersion: 1, sourceFiles: report.sourceFiles, minimum: totals }, null, 2)}\n`,
  );
  console.log(
    `coverage baseline updated: ${JSON.stringify({ sourceFiles: report.sourceFiles, minimum: totals })}`,
  );
} else if (reportOnly) {
  console.log(
    `coverage report only (no baseline enforcement): ${JSON.stringify({ sourceFiles: report.sourceFiles, minimum: totals })}`,
  );
} else {
  if (!fs.existsSync(baselineFile)) {
    throw new Error(
      'coverage baseline is missing; run node scripts/coverage-trend.mjs --update-baseline after a reviewed full test run',
    );
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  if (
    baseline.schemaVersion !== 1 ||
    !Number.isInteger(baseline.sourceFiles) ||
    baseline.sourceFiles < 1 ||
    !baseline.minimum
  ) {
    throw new Error('invalid coverage baseline');
  }
  const regressions = Object.entries(baseline.minimum)
    .filter(([name, minimum]) => totals[name] < minimum)
    .map(([name, minimum]) => `${name}: ${totals[name]}% is below ${minimum}%`);
  if (regressions.length > 0) throw new Error(`coverage regression:\n${regressions.join('\n')}`);
  console.log(
    `coverage trend passed: ${JSON.stringify({ sourceFiles: report.sourceFiles, minimum: totals })}`,
  );
}
