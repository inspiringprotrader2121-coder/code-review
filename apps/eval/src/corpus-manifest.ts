import {
  CASES,
  EXPECTED_GOLD_LABEL_COUNTS,
  evaluationCorpusFingerprint,
  evaluationCorpusLabelCounts,
  type EvalCase,
} from './cases.js';

/** Bump deliberately when a hand-verified label changes. */
export const GOLD_CORPUS_VERSION = 3;
/** Deliberate snapshot identity for the 29 positive and 6 negative labels. */
export const GOLD_CORPUS_SHA256 =
  '42e751e1651af8e4a187c3425657b18b2cc5aaac6c4a9bc1335181de9f2ef11e';

export interface GoldCorpusManifest {
  schemaVersion: 1;
  corpusVersion: number;
  sha256: string;
  cases: number;
  labels: { positive: number; negative: number };
  provenance: 'hand-verified immutable PR base/head diffs';
}

/** A compact, non-secret provenance record written next to every eval result. */
export function goldCorpusManifest(cases: readonly EvalCase[] = CASES): GoldCorpusManifest {
  return {
    schemaVersion: 1,
    corpusVersion: GOLD_CORPUS_VERSION,
    sha256: evaluationCorpusFingerprint(cases),
    cases: cases.length,
    labels: evaluationCorpusLabelCounts(cases),
    provenance: 'hand-verified immutable PR base/head diffs',
  };
}

/** Live runs may not silently turn edited labels into a new baseline. */
export function assertCanonicalGoldCorpus(): GoldCorpusManifest {
  const manifest = goldCorpusManifest();
  for (const c of CASES) {
    if (!c.evidence.path || c.evidence.path.startsWith('/') || c.evidence.path.includes('..')) {
      throw new Error(`gold corpus evidence path is invalid for ${c.name}`);
    }
    if (!Number.isSafeInteger(c.evidence.line) || c.evidence.line < 1) {
      throw new Error(`gold corpus evidence line is invalid for ${c.name}`);
    }
  }
  if (
    manifest.labels.positive !== EXPECTED_GOLD_LABEL_COUNTS.positive ||
    manifest.labels.negative !== EXPECTED_GOLD_LABEL_COUNTS.negative
  ) {
    throw new Error(
      `gold corpus label counts changed (${manifest.labels.positive} positive, ${manifest.labels.negative} negative); ` +
        'do not add inferred or competitor-only labels',
    );
  }
  if (manifest.sha256 !== GOLD_CORPUS_SHA256) {
    throw new Error(
      `gold corpus fingerprint changed (${manifest.sha256}); explicitly review and update GOLD_CORPUS_SHA256`,
    );
  }
  return manifest;
}
