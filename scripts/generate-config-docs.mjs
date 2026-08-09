#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const schemaPath = path.join(root, 'packages', 'config', 'configuration-schema.json');
const examplePath = path.join(root, '.env.example');
const documentationPath = path.join(root, 'docs', 'CONFIGURATION.md');

function escapeMarkdown(value) {
  return value.replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('\n', ' ');
}

export function readConfigurationSchema() {
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

export function validateConfigurationSchema(schema) {
  const names = new Set();
  if (!Number.isInteger(schema.version) || schema.version < 1 || !Array.isArray(schema.sections)) {
    throw new Error('configuration schema must have a positive integer version and sections');
  }
  for (const section of schema.sections) {
    if (
      !section.name ||
      !section.description ||
      !Array.isArray(section.variables) ||
      section.variables.length === 0
    ) {
      throw new Error('configuration schema sections must have a name, description, and variables');
    }
    for (const variable of section.variables) {
      if (!/^[A-Z][A-Z0-9_]*(?:<[A-Z][A-Z0-9_]*>)?$/.test(variable.name)) {
        throw new Error(`invalid configuration variable name: ${variable.name}`);
      }
      if (names.has(variable.name))
        throw new Error(`duplicate configuration variable: ${variable.name}`);
      names.add(variable.name);
      if (
        !variable.type ||
        !variable.range ||
        !variable.description ||
        !Array.isArray(variable.deprecatedAliases)
      ) {
        throw new Error(`configuration metadata is incomplete for ${variable.name}`);
      }
      if (
        variable.name.includes('<') &&
        (!Array.isArray(variable.allowedValues) || variable.allowedValues.length === 0)
      ) {
        throw new Error(`configuration template must bound its values: ${variable.name}`);
      }
      if (variable.secret && variable.example.trim()) {
        throw new Error(`secret configuration example must be blank: ${variable.name}`);
      }
      if (!variable.secret && variable.redaction === 'secret') {
        throw new Error(`non-secret configuration cannot use secret redaction: ${variable.name}`);
      }
    }
  }
  return schema;
}

export function renderEnvironmentExample(schema) {
  const lines = [
    '# Generated from packages/config/configuration-schema.json. Do not edit manually.',
    '# This file contains safe examples only. Put production values in the immutable server environment file; never commit secrets.',
  ];
  for (const section of schema.sections) {
    const variables = section.variables.filter((variable) => variable.render !== false);
    if (variables.length === 0) continue;
    lines.push('', `# --- ${section.name} ---`, `# ${section.description}`);
    for (const variable of variables) {
      lines.push(`# ${variable.description}`);
      lines.push(
        `# Type: ${variable.type}. Range/default: ${variable.range}. Redaction: ${variable.redaction}.`,
      );
      const assignment = `${variable.name}=${variable.example}`;
      lines.push(variable.enabled === false ? `# ${assignment}` : assignment);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderConfigurationDocumentation(schema) {
  const lines = [
    '# Configuration Reference',
    '',
    '> Generated from `packages/config/configuration-schema.json` by `node scripts/generate-config-docs.mjs`. Do not edit manually.',
    '',
    'This is a non-secret reference. Production values belong in the immutable server environment file and must never be committed. Secret examples are always blank; redaction describes how the value must be handled in diagnostics and interfaces.',
  ];
  for (const section of schema.sections) {
    lines.push('', `## ${section.name}`, '', section.description, '');
    lines.push(
      '| Variable | Type and range | Safe default | Secret / redaction | Compatibility aliases | Description |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const variable of section.variables) {
      const defaultValue =
        variable.render === false ? '(inherited; not rendered)' : variable.example || '(unset)';
      const secret = `${variable.secret ? 'yes' : 'no'} / ${variable.redaction}`;
      const aliases =
        variable.deprecatedAliases.length === 0
          ? '-'
          : variable.deprecatedAliases.map((name) => `\`${name}\``).join(', ');
      lines.push(
        `| \`${variable.name}\` | ${escapeMarkdown(`${variable.type}; ${variable.range}`)} | \`${escapeMarkdown(defaultValue)}\` | ${secret} | ${aliases} | ${escapeMarkdown(variable.description)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderConfigurationArtifacts(
  schema = validateConfigurationSchema(readConfigurationSchema()),
) {
  return Object.freeze({
    environment: renderEnvironmentExample(schema),
    documentation: renderConfigurationDocumentation(schema),
  });
}

function writeOrCheck(destination, contents, checkOnly) {
  if (checkOnly) {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== contents) {
      throw new Error(
        `${path.relative(root, destination)} is out of date; run node scripts/generate-config-docs.mjs`,
      );
    }
    return;
  }
  fs.writeFileSync(destination, contents);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const checkOnly = process.argv.includes('--check');
  const artifacts = renderConfigurationArtifacts();
  writeOrCheck(examplePath, artifacts.environment, checkOnly);
  writeOrCheck(documentationPath, artifacts.documentation, checkOnly);
  console.log(
    checkOnly
      ? 'generated configuration artifacts are current'
      : 'wrote .env.example and docs/CONFIGURATION.md',
  );
}
