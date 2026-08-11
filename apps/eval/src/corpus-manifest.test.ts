import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASES } from './cases.js';
import {
  GOLD_CORPUS_SHA256,
  GOLD_CORPUS_VERSION,
  assertCanonicalGoldCorpus,
  goldCorpusManifest,
} from './corpus-manifest.js';

test('gold corpus manifest binds labels to immutable PR base/head provenance', () => {
  const manifest = goldCorpusManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.corpusVersion, GOLD_CORPUS_VERSION);
  assert.equal(manifest.cases, CASES.length);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sha256, GOLD_CORPUS_SHA256);
  assert.equal(manifest.provenance, 'hand-verified immutable PR base/head diffs');
  assert.deepEqual(manifest.labels, { positive: 29, negative: 6 });
});

test('the checked-in gold corpus refuses an unreviewed fingerprint change', () => {
  assert.equal(assertCanonicalGoldCorpus().sha256, GOLD_CORPUS_SHA256);
});
