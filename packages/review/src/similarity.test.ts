import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSymbols, isStrongSymbol, sameDefectText } from './similarity.js';

// The excerpts below are copied verbatim from the PRs #231–250 benchmark dump,
// where the ±5 line window scored each pair as one competitor-only miss plus
// one Orvex-only finding.

test('a shared rare identifier matches the same defect anchored 8 lines apart', () => {
  const greptile =
    '**Coupon retry loses usage increment** When a per-user redemption completes but ' +
    '`incrementUsedCountIfAllowed` then fails, the retry sees `c';
  const orvex =
    '**P3** · `llm.general` The new `if (completed?.count === 0) { return; }` skips ' +
    '`incrementUsedCountIfAllowed` on every retry where the redemp';
  const result = sameDefectText(greptile, orvex);
  assert.equal(result.match, true);
  assert.match(result.reason, /incrementusedcountifallowed/);
});

test('content overlap matches the same OpenAPI claim anchored 6 lines apart', () => {
  const greptile =
    '**Line update missing from OpenAPI** The page now advertises `PUT /{slug}/api/lines/{id}`, ' +
    'but the revised OpenAPI document has no correspo';
  const orvex =
    '**P2** · `llm.general` The public API page now advertises `PUT /{slug}/api/lines/{id}`, ' +
    'but `backend/src/openapi.yaml` no longer defines any';
  assert.equal(sameDefectText(greptile, orvex).match, true);
});

test('truncated words still count, since excerpts are cut mid-word', () => {
  const a = 'the page at offset 500,000 emits a continuation link beyond the export ceiling';
  const b = 'only uses the `offset` argument to compute the next continuati';
  assert.ok(sameDefectText(a, b).sharedTerms >= 2);
});

test('distinct defects in one file stay separate', () => {
  const a =
    'The rate limiter allows a burst of twenty requests before the window resets, so a client ' +
    'can exceed the documented quota.';
  const b =
    'Timestamps are persisted without a timezone, so the audit trail reports the wrong hour ' +
    'for tenants outside UTC.';
  assert.equal(sameDefectText(a, b).match, false);
});

test('one ordinary shared identifier is not enough on its own', () => {
  const a = '`res.json` is called twice on the success path, producing ERR_HTTP_HEADERS_SENT.';
  const b = 'A validation failure short-circuits before `res.json`, leaving the request hanging.';
  const result = sameDefectText(a, b);
  assert.deepEqual(result.sharedSymbols, ['resjson']);
  assert.equal(result.match, false);
});

test('symbol extraction keeps multi-part names and ignores bare words', () => {
  const symbols = extractSymbols('`paginateExportRows` slices rows using GDPR_EXPORT_PAGE_SIZE');
  assert.ok(symbols.has('paginateexportrows'));
  assert.ok(symbols.has('gdprexportpagesize'));
  assert.equal(symbols.has('slices'), false);
});

test('rare identifiers are distinguished from ordinary ones', () => {
  assert.equal(isStrongSymbol('incrementusedcountifallowed'), true);
  assert.equal(isStrongSymbol('gdprexportpagesize'), true);
  assert.equal(isStrongSymbol('resjson'), false);
});
