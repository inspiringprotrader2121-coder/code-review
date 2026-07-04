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
];
