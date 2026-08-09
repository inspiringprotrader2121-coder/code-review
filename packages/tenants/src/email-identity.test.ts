import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, isDisposableEmail, looksLikeEmail } from './email-identity.js';
import { loadTenantRuntimeConfig } from './config.js';

test('gmail aliases collapse to one identity (dots + tags + googlemail)', () => {
  const canon = 'johndoe@gmail.com';
  for (const v of [
    'JohnDoe@gmail.com',
    'john.doe@gmail.com',
    'j.o.h.n.d.o.e@gmail.com',
    'johndoe+anything@gmail.com',
    'john.doe+farm42@googlemail.com',
    '  JOHN.DOE+x@GoogleMail.com  ',
  ]) {
    assert.equal(normalizeEmail(v), canon, `failed to canonicalize: ${v}`);
  }
});

test('non-gmail: +tags stripped, dots preserved (dots are significant elsewhere)', () => {
  assert.equal(normalizeEmail('Jane.Roe+ci@fastmail.com'), 'jane.roe@fastmail.com');
  assert.equal(normalizeEmail('a.b@outlook.com'), 'a.b@outlook.com'); // dots kept
  assert.equal(normalizeEmail('user+tag@company.co.uk'), 'user@company.co.uk');
});

test('two aliases of the same inbox normalize equal → detectable as one account', () => {
  assert.equal(normalizeEmail('farm.er+1@gmail.com'), normalizeEmail('farmer+2@gmail.com'));
  assert.notEqual(normalizeEmail('alice@gmail.com'), normalizeEmail('bob@gmail.com'));
});

test('malformed input degrades to lowercased/trimmed, never throws', () => {
  assert.equal(normalizeEmail('  NotAnEmail  '), 'notanemail');
  assert.equal(normalizeEmail('@nolocal.com'), '@nolocal.com');
  assert.equal(normalizeEmail('trailing@'), 'trailing@');
});

test('isDisposableEmail flags throwaway domains, not real ones', () => {
  assert.equal(isDisposableEmail('x@mailinator.com'), true);
  assert.equal(isDisposableEmail('x@10minutemail.com'), true);
  assert.equal(isDisposableEmail('x@GuerrillaMail.com'), true); // case-insensitive
  assert.equal(isDisposableEmail('dev@gmail.com'), false);
  assert.equal(isDisposableEmail('dev@company.com'), false);
});

test('looksLikeEmail rejects obvious garbage', () => {
  assert.equal(looksLikeEmail('a@b.com'), true);
  assert.equal(looksLikeEmail('no-at-sign'), false);
  assert.equal(looksLikeEmail('no@domain'), false);
  assert.equal(looksLikeEmail('two@@at.com'), false);
});

test('isDisposableEmail matches SUBDOMAINS of disposable providers', () => {
  assert.equal(
    isDisposableEmail('x@abc.mailinator.com'),
    true,
    'per-user subdomain of a disposable provider',
  );
  assert.equal(isDisposableEmail('x@deep.sub.yopmail.com'), true);
  assert.equal(
    isDisposableEmail('dev@notmailinator.com'),
    false,
    'suffix-only resemblance is not a match',
  );
  assert.equal(
    isDisposableEmail('dev@mailinator.com.evil.com'),
    false,
    'disposable as a subdomain of an attacker domain is NOT a match',
  );
});

test('isDisposableEmail handles the empty-local / no-domain edges', () => {
  assert.equal(
    isDisposableEmail('@mailinator.com'),
    false,
    'no local part — not a parseable email',
  );
  assert.equal(isDisposableEmail('x@'), false, 'no domain');
  assert.equal(isDisposableEmail('mailinator.com'), false, 'no @ at all');
  assert.equal(isDisposableEmail(''), false);
});

test('extra disposable domains are injected through the tenant runtime config', () => {
  const config = loadTenantRuntimeConfig({ ORVEX_EXTRA_DISPOSABLE_DOMAINS: 'temp.example' });
  assert.equal(isDisposableEmail('person@temp.example', config), true);
  assert.equal(isDisposableEmail('person@sub.temp.example', config), true);
});
