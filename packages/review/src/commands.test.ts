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
    assert.deepEqual(parseOrvexCommand('@orvex thoughts?', '@orvex'), { kind: 'help' });
    assert.deepEqual(parseOrvexCommand('@orvex looks great here', '@orvex'), { kind: 'help' });
  });
});
