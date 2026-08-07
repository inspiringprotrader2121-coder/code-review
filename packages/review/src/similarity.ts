/**
 * Same-defect matching: do two finding texts describe one defect?
 *
 * Used in two places that had the same blind spot. Production deduped review
 * findings on exact `file:line:ruleId`, so two passes that blamed different
 * statements of one defect both posted a comment. The benchmark clustered on
 * `same PR + same file + line within ±5`, so the same split scored as one
 * competitor-only miss PLUS one Orvex-only finding. Measured on PRs #231–250
 * that manufactured four of the ten "Greptile found it, Orvex didn't" P1s —
 * three of which missed the window by a single line:
 *
 *   ApiDocs.jsx    greptile:48 vs orvex:42   (6 lines) — identical claim
 *   coupon.js      greptile:83 vs orvex:75   (8 lines) — same retry defect
 *   gdpr.js        greptile:70 vs orvex:76   (6 lines) — same offset ceiling
 *
 * The error is not one-directional, so it cannot be waved through as
 * conservative: it inflates the miss ledger AND the Orvex-only ledger, which is
 * the same number quoted as "Orvex is noisier".
 *
 * WHY IT IS DELIBERATELY STRICT. A loose matcher silently deletes a real
 * finding in production and fakes `both caught` credit in the benchmark, both
 * worse than the under-merge it replaces. So a merge needs lexical proof that
 * two findings discuss the same code, not mere topical similarity: a shared
 * rare identifier, two shared identifiers, or a broad content-word overlap. The
 * benchmark additionally prints every similarity merge so the pairings stay
 * auditable by hand.
 */

/** Words too common in review prose to be evidence of a shared subject. */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'against', 'always', 'another', 'anything', 'because', 'been',
  'before', 'being', 'below', 'between', 'both', 'called', 'calls', 'cannot', 'case', 'change',
  'changed', 'changes', 'check', 'checks', 'code', 'could', 'depending', 'does', 'doing', 'done',
  'during', 'each', 'either', 'else', 'ensure', 'error', 'errors', 'even', 'ever', 'every',
  'existing', 'fail', 'fails', 'from', 'function', 'handle', 'handled', 'have', 'here', 'however',
  'instead', 'into', 'issue', 'just', 'keep', 'like', 'line', 'lines', 'make', 'makes', 'many',
  'means', 'might', 'more', 'most', 'must', 'need', 'needs', 'never', 'newly', 'note', 'only',
  'other', 'over', 'return', 'returns', 'same', 'severity', 'should', 'since', 'some', 'still',
  'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'thus', 'time', 'under', 'until', 'used', 'uses', 'using', 'value', 'values', 'want',
  'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'without', 'would', 'your',
]);

/** Shortest token kept as topical evidence, and shortest prefix-match overlap. */
const MIN_TERM_LEN = 4;
const MIN_PREFIX_LEN = 6;

/** An identifier this long, or split into this many parts, is rare enough that
 *  one shared occurrence in the same file is proof of a shared subject. */
const STRONG_SYMBOL_LEN = 14;
const STRONG_SYMBOL_PARTS = 3;

/** Split an identifier into its camelCase / snake_case parts. */
function identifierParts(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function normalizeSymbol(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Distinctive code identifiers: multi-part names (`paginateExportRows`,
 * `GDPR_EXPORT_PAGE_SIZE`, `_setUsernameIndex`) whether bare or inside
 * backticks. Single lowercase words are terms, not symbols — `offset` alone
 * says nothing about which defect is being described.
 */
export function extractSymbols(text: string): Set<string> {
  const out = new Set<string>();
  // Backticked spans can hold whole expressions, so mine identifiers from
  // inside them rather than treating the span as one opaque token.
  const sources = [text, ...(text.match(/`[^`]+`/g) ?? [])];
  for (const source of sources) {
    for (const raw of source.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:[._][A-Za-z0-9_$]+)*/g) ?? []) {
      const parts = identifierParts(raw);
      if (parts.length < 2) continue;
      const normalized = normalizeSymbol(raw);
      if (normalized.length < MIN_PREFIX_LEN) continue;
      out.add(normalized);
    }
  }
  return out;
}

/** True for identifiers rare enough to carry a match on their own. */
export function isStrongSymbol(symbol: string): boolean {
  return symbol.length >= STRONG_SYMBOL_LEN || identifierParts(symbol).length >= STRONG_SYMBOL_PARTS;
}

/** Content words, minus prose filler, used for topical overlap. */
export function extractTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < MIN_TERM_LEN) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Count overlap allowing prefix matches, because excerpts are truncated
 * mid-word: greptile's "…emits a conti" and Orvex's "…the next continuati" are
 * the same word cut at different points.
 */
function sharedWithPrefixes(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) {
    if (b.has(x)) {
      shared += 1;
      continue;
    }
    for (const y of b) {
      const short = x.length <= y.length ? x : y;
      const long = short === x ? y : x;
      if (short.length >= MIN_PREFIX_LEN && long.startsWith(short)) {
        shared += 1;
        break;
      }
    }
  }
  return shared;
}

export interface DefectMatch {
  match: boolean;
  /** Human-readable proof, printed in the audit section. */
  reason: string;
  sharedSymbols: string[];
  sharedTerms: number;
}

/**
 * True when two finding texts describe the same defect. Requires lexical proof
 * of a shared subject, in descending order of strength:
 *
 *   1. one shared rare identifier (`incrementUsedCountIfAllowed`);
 *   2. two shared ordinary identifiers;
 *   3. broad content overlap — four shared words at meaningful density.
 */
export function sameDefectText(a: string, b: string): DefectMatch {
  const symbolsA = extractSymbols(a);
  const symbolsB = extractSymbols(b);
  const sharedSymbols = [...symbolsA].filter((s) => symbolsB.has(s));
  const strong = sharedSymbols.filter(isStrongSymbol);

  const termsA = extractTerms(a);
  const termsB = extractTerms(b);
  const sharedTerms = sharedWithPrefixes(termsA, termsB);
  const union = termsA.size + termsB.size - sharedTerms;
  const jaccard = union > 0 ? sharedTerms / union : 0;

  if (strong.length >= 1) {
    return { match: true, reason: `rare identifier \`${strong[0]}\``, sharedSymbols, sharedTerms };
  }
  if (sharedSymbols.length >= 2) {
    return {
      match: true,
      reason: `identifiers ${sharedSymbols.slice(0, 3).map((s) => `\`${s}\``).join(', ')}`,
      sharedSymbols,
      sharedTerms,
    };
  }
  if (sharedTerms >= 4 && jaccard >= 0.18) {
    return {
      match: true,
      reason: `${sharedTerms} shared terms (jaccard ${jaccard.toFixed(2)})`,
      sharedSymbols,
      sharedTerms,
    };
  }
  return { match: false, reason: '', sharedSymbols, sharedTerms };
}
