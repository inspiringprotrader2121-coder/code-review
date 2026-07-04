import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFixToContent } from './apply.js';

const FILE = [
  'function restream(url) {',
  '  const seg = fetchSegment(url);',
  '  if (!seg) return retry(url);',
  '  cache.set(url, seg);',
  '  return seg;',
  '}',
].join('\n');

test('applyFixToContent', async (t) => {
  await t.test('replaces a unique anchor', () => {
    const result = applyFixToContent(FILE, {
      originalCode: '  if (!seg) return retry(url);',
      fixedCode: '  if (!seg) return null;',
    });
    assert.ok(result.ok);
    assert.match(result.content, /return null;/);
    assert.doesNotMatch(result.content, /return retry/);
  });

  await t.test('refuses when the anchor no longer exists (code drifted)', () => {
    const result = applyFixToContent(FILE, {
      originalCode: '  if (!segment) return retry(url);',
      fixedCode: '  if (!segment) return null;',
    });
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
  });

  await t.test('refuses a no-op fix', () => {
    const result = applyFixToContent(FILE, {
      originalCode: '  return seg;',
      fixedCode: '  return seg;',
    });
    assert.deepEqual(result, { ok: false, reason: 'noop' });
  });

  await t.test('disambiguates repeated anchors with the line hint', () => {
    const repeated = ['a();', 'log();', 'b();', 'log();', 'c();'].join('\n');
    const result = applyFixToContent(repeated, {
      originalCode: 'log();',
      fixedCode: 'logger.info();',
      line: 4,
    });
    assert.ok(result.ok);
    assert.equal(result.content, ['a();', 'log();', 'b();', 'logger.info();', 'c();'].join('\n'));
  });

  await t.test('refuses repeated anchors without a line hint', () => {
    const repeated = ['log();', 'log();'].join('\n');
    const result = applyFixToContent(repeated, {
      originalCode: 'log();',
      fixedCode: 'logger.info();',
    });
    assert.deepEqual(result, { ok: false, reason: 'ambiguous' });
  });

  await t.test('supports multi-line anchors and replacements', () => {
    const result = applyFixToContent(FILE, {
      originalCode: '  if (!seg) return retry(url);\n  cache.set(url, seg);',
      fixedCode: '  if (!seg) return null;\n  cache.set(url, seg);',
    });
    assert.ok(result.ok);
    assert.match(result.content, /return null;\n  cache\.set/);
  });

  await t.test('tolerates trailing-whitespace drift on single-line anchors', () => {
    const withTrailing = FILE.replace('  return seg;', '  return seg;  ');
    const result = applyFixToContent(withTrailing, {
      originalCode: '  return seg;',
      fixedCode: '  return normalized(seg);',
    });
    assert.ok(result.ok);
    assert.match(result.content, /normalized\(seg\)/);
  });
});
