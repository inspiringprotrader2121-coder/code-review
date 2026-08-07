import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrvexCommand } from './commands.js';

test('parseOrvexCommand', async (t) => {
  await t.test('ignores comments without the trigger', () => {
    assert.equal(parseOrvexCommand('looks good to me', '@orvex'), null);
    assert.equal(parseOrvexCommand('email me at hi@orvex.dev', '@orvex'), null);
  });

  await t.test('parses core commands, case-insensitively', () => {
    assert.deepEqual(parseOrvexCommand('@orvex review', '@orvex'), { kind: 'review' });
    assert.deepEqual(parseOrvexCommand('@Orvex REVIEW', '@orvex'), { kind: 'review' });
    assert.deepEqual(parseOrvexCommand('@orvex fix', '@orvex'), { kind: 'fix' });
    assert.deepEqual(parseOrvexCommand('@orvex fix all', '@orvex'), { kind: 'fix_all' });
    assert.deepEqual(parseOrvexCommand('@orvex fix this', '@orvex'), { kind: 'fix_this' });
    assert.deepEqual(parseOrvexCommand('@orvex help', '@orvex'), { kind: 'help' });
    assert.deepEqual(parseOrvexCommand('@orvex', '@orvex'), { kind: 'help' });
    assert.deepEqual(parseOrvexCommand('@orvex rate limit', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex rate-limit', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex quota', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex reviews remaining', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex check rate limit', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex how many reviews remaining?', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex what is my usage', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex check usage', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex show usage', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex check my usage', '@orvex'), { kind: 'rate_limit' });
    assert.deepEqual(parseOrvexCommand('@orvex how many reviews left', '@orvex'), { kind: 'rate_limit' });
  });

  await t.test('rate-limit near-miss does not hijack real commands that mention usage/quota', () => {
    // Must NOT silently become rate_limit (batch-2 regression). Longer phrases that
    // start with a known verb fall through to prompt/help — never quota status.
    for (const body of [
      '@orvex fix all CPU usage spikes',
      '@orvex review the usage metrics',
      '@orvex explain the rate limit middleware',
      '@orvex ignore this quota warning',
      '@orvex deep review of our quota module',
    ]) {
      assert.notEqual(parseOrvexCommand(body, '@orvex')?.kind, 'rate_limit', body);
    }
    assert.equal(parseOrvexCommand('@orvex fix all CPU usage spikes', '@orvex')?.kind, 'prompt');
    assert.equal(parseOrvexCommand('@orvex review the usage metrics', '@orvex')?.kind, 'prompt');
    assert.equal(parseOrvexCommand('@orvex explain the rate limit middleware', '@orvex')?.kind, 'prompt');
    assert.equal(parseOrvexCommand('@orvex deep review of our quota module', '@orvex')?.kind, 'prompt');
    assert.equal(parseOrvexCommand('@orvex update the quota module', '@orvex')?.kind, 'prompt');
    assert.equal(parseOrvexCommand('@orvex investigate our rate limit middleware', '@orvex')?.kind, 'prompt');
    assert.equal(parseOrvexCommand('@orvex check the usage of this cache', '@orvex')?.kind, 'prompt');
    assert.equal(parseOrvexCommand('@orvex how to add rate limits to this endpoint', '@orvex')?.kind, 'prompt');
    assert.equal(
      parseOrvexCommand('@orvex check if the rate limit middleware handles bursts', '@orvex')?.kind,
      'prompt',
    );
    assert.equal(parseOrvexCommand('@orvex how should we implement quota enforcement', '@orvex')?.kind, 'prompt');
    // Short quota-status asks still map to rate_limit.
    assert.equal(parseOrvexCommand('@orvex check my rate limit', '@orvex')?.kind, 'rate_limit');
    assert.equal(parseOrvexCommand('@orvex what is my quota', '@orvex')?.kind, 'rate_limit');
    // Bare exact commands still win.
    assert.deepEqual(parseOrvexCommand('@orvex fix all', '@orvex'), { kind: 'fix_all' });
    assert.deepEqual(parseOrvexCommand('@orvex ignore this', '@orvex'), { kind: 'ignore' });
  });

  await t.test('parses auto-apply variants', () => {
    assert.deepEqual(parseOrvexCommand('@orvex auto-apply on', '@orvex'), {
      kind: 'auto_apply',
      enabled: true,
    });
    assert.deepEqual(parseOrvexCommand('@orvex auto apply off', '@orvex'), {
      kind: 'auto_apply',
      enabled: false,
    });
    assert.deepEqual(parseOrvexCommand('@orvex autoapply on', '@orvex'), {
      kind: 'auto_apply',
      enabled: true,
    });
  });

  await t.test('works mid-comment and with surrounding text', () => {
    assert.deepEqual(parseOrvexCommand('hey @orvex review please\nthanks', '@orvex'), {
      kind: 'review',
    });
  });

  await t.test('parses resolve-conflicts variants', () => {
    assert.deepEqual(parseOrvexCommand('@orvex resolve conflicts', '@orvex'), { kind: 'resolve_conflicts' });
    assert.deepEqual(parseOrvexCommand('@orvex fix merge conflicts', '@orvex'), { kind: 'resolve_conflicts' });
  });

  await t.test('anything else becomes a free-form instruction', () => {
    assert.deepEqual(parseOrvexCommand('@orvex use a Set here instead of an array', '@orvex'), {
      kind: 'prompt',
      instruction: 'use a Set here instead of an array',
    });
    assert.deepEqual(parseOrvexCommand('@orvex add null checks to the auth handler', '@orvex'), {
      kind: 'prompt',
      instruction: 'add null checks to the auth handler',
    });
  });

  await t.test('trailing punctuation is tolerated on keywords', () => {
    assert.deepEqual(parseOrvexCommand('@orvex fix!', '@orvex'), { kind: 'fix' });
    assert.deepEqual(parseOrvexCommand('@orvex review.', '@orvex'), { kind: 'review' });
  });

  await t.test('rejects handle prefixes, quoted/fenced commands, and casual paid prompts', () => {
    assert.equal(parseOrvexCommand('@orvexander fix all', '@orvex'), null);
    assert.equal(parseOrvexCommand('> @orvex fix all', '@orvex'), null);
    assert.equal(parseOrvexCommand('```text\n@orvex fix all\n```', '@orvex'), null);
    assert.equal(parseOrvexCommand('~~~text\n@orvex fix all\n~~~', '@orvex'), null);
    assert.equal(parseOrvexCommand('```text\n@orvex fix all', '@orvex'), null);
    assert.deepEqual(parseOrvexCommand('@orvex thoughts?', '@orvex'), { kind: 'help' });
    assert.deepEqual(parseOrvexCommand('@orvex looks great here', '@orvex'), { kind: 'help' });
  });
});

test('`ignore <file>:<line>` targets a candidate that has no inline thread', () => {
  // Manual-review candidates render in a collapsed table with no inline
  // comment, so thread-reply `ignore` can never resolve them. Without this
  // form they were unsuppressable and reappeared on every push.
  assert.deepEqual(parseOrvexCommand('@orvex ignore src/a.ts:42'), {
    kind: 'ignore_at',
    file: 'src/a.ts',
    line: 42,
  });
  assert.deepEqual(parseOrvexCommand('@orvex dismiss lib/x.js:7'), {
    kind: 'ignore_at',
    file: 'lib/x.js',
    line: 7,
  });
  // Path case must survive: `normalized` is lowercased and would never match
  // a file actually named `Auth.ts`.
  assert.deepEqual(parseOrvexCommand('@orvex ignore src/Auth.ts'), {
    kind: 'ignore_at',
    file: 'src/Auth.ts',
  });
  // The bare forms must keep their existing thread-reply meaning.
  assert.deepEqual(parseOrvexCommand('@orvex ignore'), { kind: 'ignore' });
  assert.deepEqual(parseOrvexCommand('@orvex ignore this'), { kind: 'ignore' });
});
