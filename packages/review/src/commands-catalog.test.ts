import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHelpComment,
  formatReviewCommandsFooter,
  orvexCommandCatalog,
  formatCommandsHtmlRows,
} from './commands-catalog.js';
import { parseOrvexCommand } from './commands.js';

test('command catalog covers every parseable kind users are expected to discover', () => {
  const usages = orvexCommandCatalog().map((c) => c.usage);
  for (const required of [
    'review',
    'deep',
    'fix',
    'fix all',
    'fix this',
    '<instructions>',
    'explain',
    'ignore',
    'ignore <file>:<line>',
    'resolve conflicts',
    'auto-apply on/off',
    'rate limit',
    'help',
  ]) {
    assert.ok(usages.includes(required), `missing ${required}`);
  }
  assert.equal(orvexCommandCatalog().length, 13);
});

test('help comment and HTML rows include every catalog command', () => {
  const help = formatHelpComment('@orvex');
  const html = formatCommandsHtmlRows('@orvex');
  for (const c of orvexCommandCatalog()) {
    assert.match(help, new RegExp(`@orvex ${c.usage.replace(/[<>]/g, '\\$&')}`));
    assert.match(html, /@orvex/);
  }
  assert.match(help, /What counts toward quota/);
  assert.match(help, /Run on each commit/);
  assert.match(formatReviewCommandsFooter('@orvex'), /@orvex help/);
  assert.match(formatReviewCommandsFooter('@orvex'), /@orvex rate limit/);
});

test('catalog aliases still parse to the intended kind', () => {
  assert.equal(parseOrvexCommand('@orvex re-review')?.kind, 'review');
  assert.equal(parseOrvexCommand('@orvex deep review')?.kind, 'deep');
  assert.equal(parseOrvexCommand('@orvex fixall')?.kind, 'fix_all');
  assert.equal(parseOrvexCommand('@orvex why', '@orvex')?.kind, 'explain');
  assert.equal(parseOrvexCommand('@orvex quota')?.kind, 'rate_limit');
  assert.equal(parseOrvexCommand('@orvex ignore src/a.ts:3')?.kind, 'ignore_at');
});
