/**
 * Labeled review cases — the ground truth for measuring precision/recall.
 * Each was hand-verified against the actual code during development. Add a case
 * every time a real bug is missed or a false positive is posted.
 *
 * - shouldFlag:   the review SHOULD surface a finding matching this regex (recall)
 * - shouldNotFlag: the review must NOT surface a finding matching this (precision)
 */
export interface EvalCase {
  name: string;
  owner: string;
  repo: string;
  pr: number;
  shouldFlag?: RegExp[];
  /** Severity-aware recall: the pattern must match a finding rated AT LEAST
   *  minSeverity — a P2 bug flagged as `info` does NOT count as caught (Codex
   *  2026-07-16: text-only matching hid severity regressions). */
  shouldFlagSevere?: Array<{ pattern: RegExp; minSeverity: 'P1' | 'P2' | 'P3' }>;
  shouldNotFlag?: RegExp[];
  note?: string;
}

export const CASES: EvalCase[] = [
  {
    name: 'migration-renumber-false-positive',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 16,
    shouldNotFlag: [/reus\w* .*migration version/i, /renumber\w*.*regression/i],
    note: 'The identity-based runner ~200 lines below the hunk handles the reused version by (name), so this is not a bug.',
  },
  {
    name: 'intentional-fallback-removal',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 18,
    shouldNotFlag: [/MAIN_SERVER_URL fallback/i, /removed?.*fallback.*(break|outage)/i],
    note: 'Removing the MAIN_SERVER_URL fallback is the stated purpose of the PR — intentional, not a bug.',
  },
  {
    name: 'payment-equals-arm-nitpick',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 18,
    shouldNotFlag: [/equals arm.*(raw|escap)/i, /escapeLikeWildcards.*divergence/i],
    note: 'Prisma equality is not a LIKE query, so the equals arm needs no wildcard escaping — self-negating nitpick.',
  },
  {
    name: 'tenant-walk-weak-guard',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 18,
    shouldFlag: [/password.*length.*>=?\s*1|tenant.?walk|bypass/i],
    note: 'passwordLooksValid = length>=1 is bypassable with &password=x — a real hardening gap.',
  },
  {
    name: 'upstreamName-undefined-crash',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 18,
    shouldFlag: [/upstreamName/i, /undefined (variable|reference)/i],
    note: 'poll() catch references undefined upstreamName → ReferenceError every 20 failures. A real P1 (currently missed).',
  },
  // ——— greptile-gap regression cases (ROADMAP Phase 7) ———
  // Bugs greptile/qodo/gitar caught on 2026-07-12 that Orvex missed or under-rated.
  // The severity-calibration + hunting-rule prompt change (prompt.ts) targets these.
  {
    name: 'stripe-coupon-leak-on-failed-checkout',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 118,
    // Must be flagged AND rated ≥P2 — the whole point was that Orvex rated this
    // `info`. A text match alone would hide the severity regression.
    shouldFlagSevere: [{ pattern: /coupon.*(clean|leak|orphan|released|reserv)|reservation.*(leak|unreleased|unkeyed)/i, minSeverity: 'P2' }],
    note: 'createOneTimeStripeDiscount creates a Stripe coupon; a checkout that throws leaks it. greptile/qodo/gitar rated P2; Orvex rated info. Target: flag AND rate ≥P2.',
  },
  {
    name: 'xtream-failure-not-recorded-under-tenant-guard',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 121,
    shouldFlagSevere: [{ pattern: /(fail|error|block).*not recorded|record.*(fail|error).*(tenant|guard)|MAC.?block|download failure/i, minSeverity: 'P2' }],
    note: 'The failure/error branch skips the tenant-guarded recording the success path performs. codex/greptile caught (P1/P2); Orvex never raised it. Recall target.',
  },
  // ——— Velatrix PR #139-147 competitor benchmark (2026-07-17) ———
  // Each target below was checked against the actual PR diff and full bot
  // comment. These are ground-truth cases, not raw "another bot said so" votes.
  {
    name: 'runtime-smoke-incomplete-credential-redaction',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 139,
    shouldFlagSevere: [{ pattern: /(access_token|auth_token|client_secret|credential).*(redact|leak)|redact.*(credential|secret).*query/i, minSeverity: 'P2' }],
    note: 'The new query-key allowlist leaves common secret-bearing keys in failure details. Greptile rated P1; minimum regression threshold is P2.',
  },
  {
    name: 'gdpr-export-removes-invoices-contract',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 139,
    shouldFlagSevere: [{ pattern: /invoices.*(missing|removed|response|contract)|export.*(shape|compatib).*invoices/i, minSeverity: 'P2' }],
    note: 'The successful export response removes its established invoices field without versioning or an alias.',
  },
  {
    name: 'missing-entitlement-forces-config-reload',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 140,
    shouldFlagSevere: [{ pattern: /entitlement.*(undefined|omit|missing).*(changed|reload|reapply)|every.*(poll|sync).*(reload|changed|config)/i, minSeverity: 'P2' }],
    note: 'The load-balancer poller omits entitlements, so undefined is treated as changed and nginx is reapplied every poll.',
  },
  {
    name: 'backup-destination-update-counted-as-create',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 140,
    shouldFlagSevere: [{ pattern: /(destination|update).*(count \+ 1|quota|created|not.?found|null row)|missing destination.*success/i, minSeverity: 'P2' }],
    note: 'The shared create/update helper reports created/count+1 for an update and succeeds with row:null when the ID is absent.',
  },
  {
    name: 'existing-admin-operational-state-not-repaired',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 140,
    shouldFlagSevere: [{ pattern: /(existing|stale|inactive).*admin.*(status|panelSlug|sign.?in)|admin.*(inactive|stale).*preserv/i, minSeverity: 'P2' }],
    note: 'Preserving credentials/MFA is intentional, but preserving an inactive status or stale admin panelSlug can leave bootstrap successful with no usable administrator.',
  },
  {
    name: 'batch-url-stale-preview-race',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 141,
    shouldFlagSevere: [{ pattern: /(stale|older|out.?of.?order).*(preview|request)|preview.*(race|overwrite|old URL)/i, minSeverity: 'P2' }],
    note: 'An older asynchronous preview can resolve after input changes and restore a stale request that Update then submits.',
  },
  {
    name: 'cumulative-refund-remainder-not-recorded',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 143,
    shouldFlagSevere: [{ pattern: /(cumulative|legacy|full).*(refund).*(remainder|increment|ledger|record)|refund.*(empty|missing).*list.*(drop|skip)/i, minSeverity: 'P2' }],
    note: 'With a legacy partial marker and no expanded refund rows, the full-refund transition suspends but does not record the cumulative remainder in the ledger.',
  },
  {
    name: 'shared-tunnel-destroy-bypasses-users',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 144,
    shouldFlagSevere: [{ pattern: /destroyPool.*(close|tunnel).*(ephemeral|active|refcount)|tunnel.*closed.*(live|active|ephemeral)/i, minSeverity: 'P2' }],
    note: 'Orvex caught this at line 176 while competitors anchored line 198; the line-only benchmark incorrectly split the same defect.',
  },
  {
    name: 'failed-overlapping-pool-creation-leaks-tunnel',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 144,
    shouldFlagSevere: [{ pattern: /(pool creation|poolCreations).*(fail|failure).*(tunnel|close)|tunnel.*(leak|left open).*pool/i, minSeverity: 'P2' }],
    note: 'A distinct nearby Codex finding: an overlapping failed pool creation suppresses ephemeral cleanup, then never closes the tunnel itself.',
  },
  {
    name: 'mag-unsigned-type-overrides-session-claim',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 146,
    shouldFlagSevere: [{ pattern: /(unsigned|request|body|query|header).*(stb|device).*override.*(signed|session|token)|trusted.*stb.*precedence/i, minSeverity: 'P2' }],
    note: 'requestStbType checks unsigned request fields before the signed fallback, allowing a restricted device type to be replaced.',
  },
  {
    name: 'bootstrap-fallback-rejects-success-status',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 146,
    shouldFlagSevere: [{ pattern: /(success|dry-run).*(fallback|whitelist).*(failed|reject)|online.*(never|non.?existent).*status/i, minSeverity: 'P2' }],
    note: 'The no-Python fallback accepts online|failed, but real completion states are success and dry-run, so successful installs report failed.',
  },
  {
    name: 'legacy-ciphertext-corruption-passes-as-plaintext',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 147,
    shouldFlagSevere: [{ pattern: /(corrupt|truncat|malformed).*(legacy|cipher|encrypt).*(plaintext|pass|return)|legacy.*ciphertext.*fail closed/i, minSeverity: 'P2' }],
    note: 'Orvex found this but rated it P3; credential corruption must fail closed and meet the P2 threshold.',
  },
  {
    name: 'missing-tenant-error-variant-misclassified',
    owner: 'inspiringprotrader2121-coder', repo: 'Velatrix-Cloud', pr: 147,
    shouldFlagSevere: [{ pattern: /(Database for panel|missing tenant).*(503|unavailable|misclass)|tenant.*(error|message|variant).*(404|503)/i, minSeverity: 'P2' }],
    note: 'The production pool manager emits a second missing-database message that the new 404 classifier does not match.',
  },
];
