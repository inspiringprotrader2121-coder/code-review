#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import {
  readConfigurationSchema,
  renderConfigurationArtifacts,
  validateConfigurationSchema,
} from './generate-config-docs.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const schema = validateConfigurationSchema(readConfigurationSchema());
const variableNames = new Set(
  schema.sections.flatMap((section) => section.variables.map((variable) => variable.name)),
);
const providerTemplate = 'ORVEX_PROVIDER_CONCURRENCY_<PROVIDER>';
const sourceRoots = [
  path.join(root, 'packages', 'config', 'src'),
  path.join(root, 'apps', 'server', 'src', 'bootstrap'),
];
const additionalSourceFiles = [
  path.join(root, 'apps', 'server', 'src', 'sandbox-runtime-options.ts'),
];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function isEnvironment(node) {
  return ts.isIdentifier(node) && node.text === 'env';
}

function isProcessEnvironment(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

function sourceLocation(source, node) {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${path.relative(root, source.fileName)}:${position.line + 1}`;
}

function isProviderConcurrencyTemplate(node) {
  return (
    ts.isTemplateExpression(node) &&
    node.head.text === 'ORVEX_PROVIDER_CONCURRENCY_' &&
    node.templateSpans.length === 1 &&
    ts.isIdentifier(node.templateSpans[0].expression) &&
    node.templateSpans[0].expression.text === 'name' &&
    node.templateSpans[0].literal.text === ''
  );
}

const reads = new Map();
const errors = [];

function register(name, source, node) {
  const locations = reads.get(name) ?? [];
  locations.push(sourceLocation(source, node));
  reads.set(name, locations);
  if (!variableNames.has(name))
    errors.push(`${sourceLocation(source, node)} reads undocumented ${name}`);
}

for (const file of [...sourceRoots.flatMap(walk), ...additionalSourceFiles]) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      (isEnvironment(node.expression) || isProcessEnvironment(node.expression))
    ) {
      register(node.name.text, source, node);
    }
    if (
      ts.isElementAccessExpression(node) &&
      (isEnvironment(node.expression) || isProcessEnvironment(node.expression))
    ) {
      const argument = node.argumentExpression;
      if (argument && ts.isStringLiteral(argument)) register(argument.text, source, node);
      else if (argument && isProviderConcurrencyTemplate(argument)) {
        register(providerTemplate, source, node);
      } else {
        errors.push(`${sourceLocation(source, node)} uses undocumented dynamic environment access`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const artifacts = renderConfigurationArtifacts(schema);
for (const [file, contents] of [
  ['.env.example', artifacts.environment],
  ['docs/CONFIGURATION.md', artifacts.documentation],
]) {
  const destination = path.join(root, file);
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== contents) {
    errors.push(`${file} is not current with packages/config/configuration-schema.json`);
  }
}

if (errors.length > 0) {
  console.error('configuration schema drift check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `configuration schema check passed: ${reads.size} registered read(s), generated artifacts are current`,
  );
}
