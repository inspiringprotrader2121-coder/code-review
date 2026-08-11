import { createHash } from 'node:crypto';

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
  /** Severity-aware recall with optional FILE SCOPING. A P2 bug reported as
   *  `info` does NOT count as caught — text-only matching hid severity
   *  regressions. `file` is matched against
   *  the finding's path SEPARATELY, so the path can no longer hand free tokens to
   *  the content pattern (measured: `src/lib/redis.js` alone satisfied a
   *  `redis.*end` pattern via the word "depends"). Patterns should carry the `s`
   *  flag — model messages are multi-line, and a `.*` chain that can't cross a
   *  newline fails on a correct description purely by paragraph break. */
  shouldFlagSevere?: Array<{ pattern: RegExp; minSeverity: 'P1' | 'P2' | 'P3'; file?: RegExp }>;
  shouldNotFlag?: RegExp[];
  /** Immutable head SHA the case was hand-verified against. */
  sha: string;
  /** Immutable PR base SHA paired with `sha`, so the reviewed diff cannot drift. */
  baseSha: string;
  /**
   * A source-level witness for the hand-verified label.  This is deliberately
   * separate from the matcher: regexes score model output, while this pin lets
   * an auditor inspect the exact immutable source location that was labelled.
   */
  evidence: LabelEvidence;
  note?: string;
}

export interface LabelEvidence {
  sha: string;
  path: string;
  line: number;
  provenance: 'hand-verified-immutable-source';
  /** Whether the historic review missed the defect or rated it below target. */
  reviewOutcome: 'missed' | 'under-rated' | 'false-positive';
}

type UnwitnessedEvalCase = Omit<EvalCase, 'evidence'>;
type EvidenceWithoutCommit = Omit<LabelEvidence, 'sha'>;

const CASES_WITHOUT_EVIDENCE: UnwitnessedEvalCase[] = [
  {
    name: 'migration-renumber-false-positive',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 16,
    sha: 'd885adfc42dcece12e6a8bb6c4c3e61d4fde9902',
    baseSha: '7ca5e74a7f8f499edb027ba2c9e46c73a4cdb410',
    shouldNotFlag: [/reus\w* .*migration version/i, /renumber\w*.*regression/i],
    note: 'The identity-based runner ~200 lines below the hunk handles the reused version by (name), so this is not a bug.',
  },
  {
    name: 'intentional-fallback-removal',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 18,
    sha: '2f38cc56d3e8209bfd3ad5ff210a17674c45423b',
    baseSha: '7ca5e74a7f8f499edb027ba2c9e46c73a4cdb410',
    shouldNotFlag: [/MAIN_SERVER_URL fallback/i, /removed?.*fallback.*(break|outage)/i],
    note: 'Removing the MAIN_SERVER_URL fallback is the stated purpose of the PR — intentional, not a bug.',
  },
  {
    name: 'payment-equals-arm-nitpick',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 18,
    sha: '243cff514b93021101cacf252f47950ab2f6b45d',
    baseSha: '7ca5e74a7f8f499edb027ba2c9e46c73a4cdb410',
    shouldNotFlag: [/equals arm.*(raw|escap)/i, /escapeLikeWildcards.*divergence/i],
    note: 'Prisma equality is not a LIKE query, so the equals arm needs no wildcard escaping — self-negating nitpick.',
  },
  {
    name: 'tenant-walk-weak-guard',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 18,
    sha: 'e0b41179199967992e9478bae1e1abecb2e69995',
    baseSha: '7ca5e74a7f8f499edb027ba2c9e46c73a4cdb410',
    shouldFlag: [/password.*length.*>=?\s*1|tenant.?walk|bypass/i],
    note: 'passwordLooksValid = length>=1 is bypassable with &password=x — a real hardening gap.',
  },
  {
    name: 'upstreamName-undefined-crash',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 18,
    sha: '2f38cc56d3e8209bfd3ad5ff210a17674c45423b',
    baseSha: '7ca5e74a7f8f499edb027ba2c9e46c73a4cdb410',
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
    sha: '576ee02cce7e27947f2b7f4942be82331752409a',
    baseSha: '14652cbf5595d58af8081cc39143ed037a5f4350',
    // Must be flagged AND rated ≥P2 — the whole point was that Orvex rated this
    // `info`. A text match alone would hide the severity regression.
    shouldFlagSevere: [
      {
        pattern:
          /coupon.*(clean|leak|orphan|released|reserv)|reservation.*(leak|unreleased|unkeyed)/i,
        minSeverity: 'P2',
      },
    ],
    note: 'createOneTimeStripeDiscount creates a Stripe coupon; a checkout that throws leaks it. greptile/qodo/gitar rated P2; Orvex rated info. Target: flag AND rate ≥P2.',
  },
  {
    name: 'xtream-failure-not-recorded-under-tenant-guard',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 121,
    sha: '387ad32bb4f66a36428bd55c39a57cc9d3e955a1',
    baseSha: '14652cbf5595d58af8081cc39143ed037a5f4350',
    shouldFlagSevere: [
      {
        pattern:
          /(fail|error|block).*not recorded|record.*(fail|error).*(tenant|guard)|MAC.?block|download failure/i,
        minSeverity: 'P2',
      },
    ],
    note: 'The failure/error branch skips the tenant-guarded recording the success path performs. codex/greptile caught (P1/P2); Orvex never raised it. Recall target.',
  },
  // ——— Velatrix PR #139-147 competitor benchmark (2026-07-17) ———
  // Each target below was checked against the actual PR diff and full bot
  // comment. These are ground-truth cases, not raw "another bot said so" votes.
  {
    name: 'runtime-smoke-incomplete-credential-redaction',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 139,
    sha: 'a4a051660faf53109adf533546fec2ac90e2573c',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(access_token|auth_token|client_secret|credential).*(redact|leak)|redact.*(credential|secret).*query/i,
        minSeverity: 'P2',
      },
    ],
    note: 'The new query-key allowlist leaves common secret-bearing keys in failure details. Greptile rated P1; minimum regression threshold is P2.',
  },
  {
    name: 'gdpr-export-removes-invoices-contract',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 139,
    sha: 'a4a051660faf53109adf533546fec2ac90e2573c',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /invoices.*(missing|removed|response|contract)|export.*(shape|compatib).*invoices/i,
        minSeverity: 'P2',
      },
    ],
    note: 'The successful export response removes its established invoices field without versioning or an alias.',
  },
  {
    name: 'missing-entitlement-forces-config-reload',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 140,
    sha: 'b98fd688b8336c8cdf541f1ca1338c379017857a',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /entitlement.*(undefined|omit|missing).*(changed|reload|reapply)|every.*(poll|sync).*(reload|changed|config)/i,
        minSeverity: 'P2',
      },
    ],
    note: 'The load-balancer poller omits entitlements, so undefined is treated as changed and nginx is reapplied every poll.',
  },
  {
    name: 'backup-destination-update-counted-as-create',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 140,
    sha: 'b98fd688b8336c8cdf541f1ca1338c379017857a',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(destination|update).*(count \+ 1|quota|created|not.?found|null row)|missing destination.*success/i,
        minSeverity: 'P2',
      },
    ],
    note: 'The shared create/update helper reports created/count+1 for an update and succeeds with row:null when the ID is absent.',
  },
  {
    name: 'existing-admin-operational-state-not-repaired',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 140,
    sha: 'b98fd688b8336c8cdf541f1ca1338c379017857a',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(existing|stale|inactive).*admin.*(status|panelSlug|sign.?in)|admin.*(inactive|stale).*preserv/i,
        minSeverity: 'P2',
      },
    ],
    note: 'Preserving credentials/MFA is intentional, but preserving an inactive status or stale admin panelSlug can leave bootstrap successful with no usable administrator.',
  },
  {
    name: 'batch-url-stale-preview-race',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 141,
    sha: '61086b12e02ae71303c483a2b001c2553028b8c6',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(stale|older|out.?of.?order).*(preview|request)|preview.*(race|overwrite|old URL)/i,
        minSeverity: 'P2',
      },
    ],
    note: 'An older asynchronous preview can resolve after input changes and restore a stale request that Update then submits.',
  },
  {
    name: 'cumulative-refund-remainder-not-recorded',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 143,
    sha: '65aaaf95756ecaeb47f63ccc4dc1e127d0892bf2',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(cumulative|legacy|full).*(refund).*(remainder|increment|ledger|record)|refund.*(empty|missing).*list.*(drop|skip)/i,
        minSeverity: 'P2',
      },
    ],
    note: 'With a legacy partial marker and no expanded refund rows, the full-refund transition suspends but does not record the cumulative remainder in the ledger.',
  },
  {
    name: 'shared-tunnel-destroy-bypasses-users',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 144,
    sha: 'bda85a0855489dba68d881b39676ba386287b40a',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /destroyPool.*(close|tunnel).*(ephemeral|active|refcount)|tunnel.*closed.*(live|active|ephemeral)/i,
        minSeverity: 'P2',
      },
    ],
    note: 'Orvex caught this at line 176 while competitors anchored line 198; the line-only benchmark incorrectly split the same defect.',
  },
  {
    name: 'failed-overlapping-pool-creation-leaks-tunnel',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 144,
    sha: 'bda85a0855489dba68d881b39676ba386287b40a',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(pool creation|poolCreations).*(fail|failure).*(tunnel|close)|tunnel.*(leak|left open).*pool/i,
        minSeverity: 'P2',
      },
    ],
    note: 'A distinct nearby Codex finding: an overlapping failed pool creation suppresses ephemeral cleanup, then never closes the tunnel itself.',
  },
  {
    name: 'mag-unsigned-type-overrides-session-claim',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 146,
    sha: '5ea35cea210cb9647d0aecffc5e229f414213a83',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(unsigned|request|body|query|header).*(stb|device).*override.*(signed|session|token)|trusted.*stb.*precedence/i,
        minSeverity: 'P2',
      },
    ],
    note: 'requestStbType checks unsigned request fields before the signed fallback, allowing a restricted device type to be replaced.',
  },
  {
    name: 'bootstrap-fallback-rejects-success-status',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 146,
    sha: '5ea35cea210cb9647d0aecffc5e229f414213a83',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(success|dry-run).*(fallback|whitelist).*(failed|reject)|online.*(never|non.?existent).*status/i,
        minSeverity: 'P2',
      },
    ],
    note: 'The no-Python fallback accepts online|failed, but real completion states are success and dry-run, so successful installs report failed.',
  },
  {
    name: 'legacy-ciphertext-corruption-passes-as-plaintext',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 147,
    sha: '8f6be04d672e93be4e9c988c43298146ec412861',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(corrupt|truncat|malformed).*(legacy|cipher|encrypt).*(plaintext|pass|return)|legacy.*ciphertext.*fail closed/i,
        minSeverity: 'P2',
      },
    ],
    note: 'Orvex found this but rated it P3; credential corruption must fail closed and meet the P2 threshold.',
  },
  {
    name: 'missing-tenant-error-variant-misclassified',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 147,
    sha: '8f6be04d672e93be4e9c988c43298146ec412861',
    baseSha: '1e11bd9fe387bbd7071c005f016259bdc62fadd8',
    shouldFlagSevere: [
      {
        pattern:
          /(Database for panel|missing tenant).*(503|unavailable|misclass)|tenant.*(error|message|variant).*(404|503)/i,
        minSeverity: 'P2',
      },
    ],
    note: 'The production pool manager emits a second missing-database message that the new 404 classifier does not match.',
  },

  // ——— bench170: P1s from the 161-170 competitor benchmark that Orvex MISSED ———
  // (competitor consensus = ground truth; each was verified in the bench output.
  //  These are the permanent regression set for high-severity recall.)
  {
    name: 'bench170-logger-header-mutation',
    sha: '3a37fb538526254872e892baf926911985ffb611',
    baseSha: '5a8faf4c80f59af34dcf48dd4412366a93d9284b',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 163,
    shouldFlagSevere: [
      {
        file: /logger/i,
        pattern:
          /^(?=[\s\S]*(serializeError|scrub|sanitiz|redact))(?=[\s\S]*(mutat|modif|rewrit|in[-\s]?place|rather than a copy|not a copy|reassign|overwrit))(?=[\s\S]*(header|err\.config|request (config|object)|shared object|caller|live request))/is,
        minSeverity: 'P2',
      },
    ],
    note: 'greptile+coderabbit+codex consensus P1: serializeError/scrub mutates err.config.headers in place, corrupting the live request object.',
  },
  {
    name: 'bench170-mysql-root-host-widened',
    sha: '2111b11377ae2009c037c6c734886c42cf408e7d',
    baseSha: '5a8faf4c80f59af34dcf48dd4412366a93d9284b',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 165,
    shouldFlagSevere: [
      {
        file: /docker-compose|\.env|mysql/i,
        pattern:
          /^(?=[\s\S]*(MYSQL_ROOT_HOST|\broot\b))(?=[\s\S]*(%|wildcard|any host|anywhere|any peer|any container|data_net|widen))/is,
        minSeverity: 'P2',
      },
    ],
    note: 'gitar+codex consensus P1: MYSQL_ROOT_HOST default widened localhost → % lets any data_net peer connect as root.',
  },
  {
    name: 'bench170-compose-api-migrations-parity',
    sha: '2111b11377ae2009c037c6c734886c42cf408e7d',
    baseSha: '5a8faf4c80f59af34dcf48dd4412366a93d9284b',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 165,
    shouldFlagSevere: [
      {
        file: /docker-compose|k8s|deployment|compose/i,
        pattern:
          /^(?=[\s\S]*(RUN_STARTUP_MIGRATIONS|startup migration))(?=[\s\S]*\bapi\b)(?=[\s\S]*(missing|absent|not set|unset|omit|lacks|does not|only|parity|forgot))/is,
        minSeverity: 'P2',
      },
    ],
    note: 'coderabbit+codex consensus P1: the api compose service is missing RUN_STARTUP_MIGRATIONS=false — service-parity bug, needs whole-file/sibling context.',
  },
  {
    name: 'bench170-provision-retry-stale-resources',
    sha: '2e06339bd6ee219c5cfc29cb58e6ab3c578ac796',
    baseSha: '5a8faf4c80f59af34dcf48dd4412366a93d9284b',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 167,
    shouldFlagSevere: [
      {
        file: /tenantProvisioning/i,
        pattern:
          /^(?=[\s\S]*_resources)(?=[\s\S]*(stale|previous|prior|earlier|reused|re-used|carried|not reset|leak|inherit|persist))(?=[\s\S]*(retry|attempt|resume|re-?run))/is,
        minSeverity: 'P2',
      },
    ],
    note: 'gitar+codex consensus P1: _executeProvisionJob retry reuses stale _resources from a prior attempt.',
  },
  {
    name: 'bench170-webhook-success-stays-pending',
    sha: '42d731c96538303596aaffce879aeb228919d3b2',
    baseSha: '5a8faf4c80f59af34dcf48dd4412366a93d9284b',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 168,
    shouldFlagSevere: [
      {
        file: /webhook/i,
        pattern:
          /^(?=[\s\S]*(pending|retry (row|record|queue|entry)|queued))(?=[\s\S]*(succe|delivered|2xx))(?=[\s\S]*(surviv|never (cleared|completed|resolved|removed)|stays?|remains?|left|duplicate|redeliver|not (cleared|removed)))/is,
        minSeverity: 'P2',
      },
    ],
    note: 'greptile+qodo consensus P1: when delivery succeeds but the completion update fails, the pre-created retry row stays pending → duplicate delivery.',
  },
  {
    name: 'bench170-nginx-real-ip-spoof',
    sha: 'f4d763122f5af58648c3feb98bf72b85691f443e',
    baseSha: '5a8faf4c80f59af34dcf48dd4412366a93d9284b',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 170,
    shouldFlagSevere: [
      {
        file: /nginx|\.conf$/i,
        pattern:
          /^(?=[\s\S]*(X-Real-IP|real_ip|realip))(?=[\s\S]*(spoof|forge|impersonat|untrusted|attacker|client[-\s]?(supplied|controlled|provided|sent)|bypass|trusts? (the )?client))/is,
        minSeverity: 'P2',
      },
    ],
    note: 'greptile P1: the nginx map forwards client-supplied X-Real-IP when requests bypass the edge — identity spoofing.',
  },
  {
    name: 'bench170-redis-end-stays-unready',
    sha: '0e7cbcc3abfb57afdfdbd5268604903a219697c9',
    baseSha: '5a8faf4c80f59af34dcf48dd4412366a93d9284b',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 169,
    shouldFlagSevere: [
      {
        file: /redis|readiness/i,
        pattern:
          /^(?=[\s\S]*(['"`]end['"`]|\bend\b event|on\(\s*['"`]end|disconnect|connection closed|client\s*=\s*null))(?=[\s\S]*(never|nothing|not|no longer))(?=[\s\S]*(re-?creat|re-?connect|re-?initial|unready|stays? false|remains? false|forever))/is,
        minSeverity: 'P2',
      },
    ],
    note: 'greptile P1: on Redis `end` the shared module clears the client and never recreates it — readiness stays failed forever.',
  },
  {
    name: 'bench170-inherited-slug-rollback',
    sha: '2e06339bd6ee219c5cfc29cb58e6ab3c578ac796',
    baseSha: '5a8faf4c80f59af34dcf48dd4412366a93d9284b',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 167,
    shouldFlagSevere: [
      {
        file: /tenantProvisioning/i,
        pattern:
          /^(?=[\s\S]*panelSlug)(?=[\s\S]*(earlier|previous|prior|resumed?|inherit))(?=[\s\S]*(rollback|roll back|delet|destro|teardown|wrong panel|another panel))/is,
        minSeverity: 'P2',
      },
    ],
    note: 'greptile P1: a resumed job initializes panelSlug from an earlier attempt, so an early failure can destructively roll back the wrong panel.',
  },
  // --- Velatrix PR #280 audit-export regression cases (2026-08-11) ---
  // These labels are verified against immutable source, not inferred only from
  // another reviewer's comment. The first is the original partial-export defect;
  // the latter two remain after the spool follow-up at the PR's current head.
  {
    name: 'audit-export-client-backpressure-truncates-snapshot',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 280,
    sha: '639a97595d5a8d1d51c9f83e327ba507090f4bc2',
    baseSha: 'c7b3cc856b77b5692ec41742bdc04deb839393a7',
    shouldFlagSevere: [
      {
        file: /backend\/src\/services\/auth\.js/i,
        pattern:
          /(?:client|response|res\.).*(?:backpressure|drain|write)|(?:transaction|snapshot).*(?:timeout|partial|truncat)|(?:csv|export).*(?:partial|truncat|timeout)/is,
        minSeverity: 'P1',
      },
    ],
    note: 'The Repeatable Read transaction waits for client-paced res.write drains. A slow download can exceed its fixed timeout after CSV bytes are sent, leaving a silently truncated compliance export.',
  },
  {
    name: 'audit-export-hard-timeout-breaks-uncapped-export',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 280,
    sha: '350302622d3a068b6d8a5c7c371c8e145338f1a4',
    baseSha: 'c7b3cc856b77b5692ec41742bdc04deb839393a7',
    shouldFlagSevere: [
      {
        file: /backend\/src\/services\/auth\.js/i,
        pattern:
          /(?:uncapped|large|complete).*(?:export|csv).*(?:timeout|fail)|(?:transaction|snapshot).*(?:5|10).*(?:minute|timeout).*(?:export|csv)/is,
        minSeverity: 'P2',
      },
    ],
    note: 'The follow-up moves HTTP backpressure outside the transaction, but still materializes every row under a fixed 5-minute default and 10-minute ceiling. A legitimate large export can therefore fail rather than fulfilling the new uncapped-export contract.',
  },
  {
    name: 'audit-export-pipeline-error-keeps-download-headers',
    owner: 'inspiringprotrader2121-coder',
    repo: 'Velatrix-Cloud',
    pr: 280,
    sha: '350302622d3a068b6d8a5c7c371c8e145338f1a4',
    baseSha: 'c7b3cc856b77b5692ec41742bdc04deb839393a7',
    shouldFlagSevere: [
      {
        file: /backend\/src\/services\/auth\.js/i,
        pattern:
          /(?:content-disposition|attachment|csv).*(?:error|500|pipeline|header)|(?:pipeline|createReadStream).*(?:destroy|error|500|header)/is,
        minSeverity: 'P2',
      },
    ],
    note: 'The route sets CSV download headers before pipeline(createReadStream(...), res). A pre-write source/pipeline failure can leave a JSON error with download headers or a destroyed response, so the administrator does not receive a usable route error.',
  },
];

/**
 * Immutable source witnesses for the labelled corpus. The source repository,
 * base/head SHAs and this path/line are all incorporated into the corpus
 * fingerprint below. Do not add a matcher without an independently
 * hand-verified witness here.
 */
const EVIDENCE_BY_CASE: Record<string, EvidenceWithoutCommit> = {
  'migration-renumber-false-positive': {
    path: 'backend/src/lib/clientMigrations.js',
    line: 2429,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'false-positive',
  },
  'intentional-fallback-removal': {
    path: 'backend/src/jobs/mainServerAssetResync.js',
    line: 696,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'false-positive',
  },
  'payment-equals-arm-nitpick': {
    path: 'backend/src/services/payment.js',
    line: 815,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'false-positive',
  },
  'tenant-walk-weak-guard': {
    path: 'backend/src/middleware/iptvTenantResolver.js',
    line: 96,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'upstreamName-undefined-crash': {
    path: 'backend/agent/lb-config-poller.js',
    line: 645,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'stripe-coupon-leak-on-failed-checkout': {
    path: 'backend/src/services/payment.js',
    line: 1095,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'under-rated',
  },
  'xtream-failure-not-recorded-under-tenant-guard': {
    path: 'backend/src/services/xtreamPlayerApi.js',
    line: 165,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'runtime-smoke-incomplete-credential-redaction': {
    path: 'backend/src/scripts/tenant-runtime-smoke.js',
    line: 60,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'gdpr-export-removes-invoices-contract': {
    path: 'backend/src/routes/gdpr.js',
    line: 102,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'missing-entitlement-forces-config-reload': {
    path: 'backend/src/services/nodeApi.js',
    line: 39,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'backup-destination-update-counted-as-create': {
    path: 'backend/src/repositories/backupDestination.js',
    line: 188,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'existing-admin-operational-state-not-repaired': {
    path: 'backend/agent/velatrix-agent.js',
    line: 4427,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'batch-url-stale-preview-race': {
    path: 'frontend/src/components/modals/streams/BatchUrlModal.jsx',
    line: 36,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'cumulative-refund-remainder-not-recorded': {
    path: 'backend/src/services/payment.js',
    line: 1069,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'shared-tunnel-destroy-bypasses-users': {
    path: 'backend/src/lib/clientDbManager.js',
    line: 285,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'under-rated',
  },
  'failed-overlapping-pool-creation-leaks-tunnel': {
    path: 'backend/src/lib/clientDbManager.js',
    line: 93,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'mag-unsigned-type-overrides-session-claim': {
    path: 'backend/src/lib/mag-route-helpers.js',
    line: 35,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bootstrap-fallback-rejects-success-status': {
    path: 'backend/agent/bootstrap.sh',
    line: 75,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'legacy-ciphertext-corruption-passes-as-plaintext': {
    path: 'backend/src/lib/crypto.js',
    line: 69,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'under-rated',
  },
  'missing-tenant-error-variant-misclassified': {
    path: 'backend/src/lib/clientDbManager.js',
    line: 59,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bench170-logger-header-mutation': {
    path: 'backend/src/lib/logger.js',
    line: 170,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bench170-mysql-root-host-widened': {
    path: 'docker-compose.yml',
    line: 239,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bench170-compose-api-migrations-parity': {
    path: 'docker-compose.yml',
    line: 239,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bench170-provision-retry-stale-resources': {
    path: 'backend/src/services/tenantProvisioning.js',
    line: 155,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bench170-webhook-success-stays-pending': {
    path: 'backend/src/services/webhook.js',
    line: 403,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bench170-nginx-real-ip-spoof': {
    path: 'frontend/nginx.conf',
    line: 142,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bench170-redis-end-stays-unready': {
    path: 'backend/src/lib/readiness.js',
    line: 66,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'bench170-inherited-slug-rollback': {
    path: 'backend/src/services/tenantProvisioning.js',
    line: 188,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'audit-export-client-backpressure-truncates-snapshot': {
    path: 'backend/src/services/auth.js',
    line: 1813,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'audit-export-hard-timeout-breaks-uncapped-export': {
    path: 'backend/src/services/auth.js',
    line: 1859,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'missed',
  },
  'audit-export-pipeline-error-keeps-download-headers': {
    path: 'backend/src/services/auth.js',
    line: 1883,
    provenance: 'hand-verified-immutable-source',
    reviewOutcome: 'under-rated',
  },
};

export const CASES: EvalCase[] = CASES_WITHOUT_EVIDENCE.map((entry) => {
  const evidence = EVIDENCE_BY_CASE[entry.name];
  if (!evidence) throw new Error(`missing immutable evidence witness for ${entry.name}`);
  return { ...entry, evidence: { ...evidence, sha: entry.sha } };
});

/**
 * A run records this digest with its precision/recall output. It covers the
 * immutable commit pins and every existing label, so results can be tied to the
 * exact corpus without fabricating a new ground-truth case.
 */
export function evaluationCorpusFingerprint(cases: readonly EvalCase[] = CASES): string {
  const snapshot = cases.map((c) => ({
    name: c.name,
    owner: c.owner,
    repo: c.repo,
    pr: c.pr,
    sha: c.sha,
    baseSha: c.baseSha,
    evidence: c.evidence,
    shouldFlag: c.shouldFlag?.map((pattern) => [pattern.source, pattern.flags]),
    shouldFlagSevere: c.shouldFlagSevere?.map((label) => ({
      pattern: [label.pattern.source, label.pattern.flags],
      minSeverity: label.minSeverity,
      file: label.file ? [label.file.source, label.file.flags] : undefined,
    })),
    shouldNotFlag: c.shouldNotFlag?.map((pattern) => [pattern.source, pattern.flags]),
    note: c.note,
  }));
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function evaluationCorpusLabelCounts(cases: readonly EvalCase[] = CASES): {
  positive: number;
  negative: number;
} {
  return cases.reduce(
    (counts, c) => ({
      positive: counts.positive + (c.shouldFlag?.length ?? 0) + (c.shouldFlagSevere?.length ?? 0),
      negative: counts.negative + (c.shouldNotFlag?.length ?? 0),
    }),
    { positive: 0, negative: 0 },
  );
}

/** The gold corpus is intentionally a fixed regression set, not a growing
 * collection of competitor claims. Any count change needs a reviewed corpus
 * version and fingerprint update. */
export const EXPECTED_GOLD_LABEL_COUNTS = { positive: 29, negative: 6 } as const;
