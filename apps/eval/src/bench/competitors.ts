/**
 * Competitor coverage benchmark — Orvex vs codex / greptile / coderabbit / qodo / gitar
 * on the owner's own PRs. Read-only; runs on the server with the App token.
 *
 *   run:     ORVEX_INSTALL_ID=144378482 tsx src/bench/competitors.ts
 *   combine: tsx src/bench/competitors.ts --combine    (sums all saved batches)
 *
 * WHAT IT MEASURES — anchored, line-level findings (file:line), because that is
 * the only thing comparable across tools. Sources per tool:
 *   - inline review comments (codex, greptile, qodo, gitar, orvex-inline)
 *   - Orvex's review-summary TABLE rows — parsed so Orvex is not undercounted
 *
 * ⚠ READ BEFORE QUOTING ANY NUMBER FROM THIS TOOL.
 * That second source belongs to Orvex ALONE. No competitor's prose body is
 * mined for findings here, so a tool that posts only prose contributes zero
 * findings while still being marked "reviewed" — its entire score is then
 * `orvexOnly`, which is an arithmetic identity, not a capability result. It
 * compounds: table rows have `line === null`, and `sameClusterLine` returns
 * false whenever either side is null, so an un-anchored Orvex row can never
 * cluster with a competitor's finding however well it matches — a guaranteed
 * free `orvexOnly` that simultaneously inflates `compOnly`.
 *
 * Therefore the report prints an ANCHORED (inline-vs-inline) split — the only
 * like-for-like comparison — alongside the legacy ALL split, which is retained
 * for continuity and is Orvex-favourable by construction. Quote ANCHORED.
 * Where a competitor's anchored total is 0, the tool says so explicitly rather
 * than letting the zero read as a loss.
 *
 * Findings are clustered into candidate defects by same PR + file, and then
 * either line within ±5 or a same-defect text match (see `similarity.ts`) —
 * tools anchor one defect to whichever statement they blame, and a pure line
 * window split those into a false "Orvex missed" plus a false "Orvex-only".
 * Text-based merges are listed under NEAR-MATCH MERGES for hand audit.
 * Pairwise vs Orvex: both caught / competitor-only (Orvex missed) / Orvex-only.
 *
 * CAVEAT: this is COVERAGE (who flagged what), not correctness — a one-tool-only
 * finding may be a real miss by the others OR a false positive by the flagger.
 * Line clustering can also split the same root cause when tools anchor different
 * statements, or merge different defects anchored to one branch. Treat the dump
 * as a diagnostic queue and validate the code/comments before tuning.
 * The "Orvex missed" list is dumped so those can be judged by hand for fine-tuning.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Octokit } from '@octokit/rest';
import { createBenchmarkOctokit } from './github-auth.js';
import { parseOrvexFindingTables } from './orvex-table.js';
import { severityOf, worseSev, sameClusterLine, isOrvexStatusComment } from './severity.js';
import { sameDefectText } from '@orvex-review/review';

const OWNER = process.env.BENCH_OWNER ?? 'inspiringprotrader2121-coder';
const REPO = process.env.BENCH_REPO ?? 'Velatrix-Cloud';
const PR_LO = Number(process.env.BENCH_PR_LO ?? 114);
const PR_HI = Number(process.env.BENCH_PR_HI ?? 123);
const COMPETITORS = ['codex', 'greptile', 'coderabbit', 'qodo', 'gitar'] as const;
/**
 * ISO cutoff that isolates ONE Orvex prompt era. Re-reviewing a PR leaves the
 * old era's comments in place, and `dedupeRepeats` only drops byte-identical
 * re-reports, so without this a "did the new pipeline help?" run scores the old
 * and new pipelines fused together. Competitor findings are never filtered —
 * they reviewed once. PRs the new era did not review are dropped rather than
 * counted as a clean zero-finding Orvex run.
 */
const ORVEX_SINCE = process.env.BENCH_ORVEX_SINCE ?? '';
/**
 * Upper bound for the same window. Without it the era filter is open-ended, so
 * the only selectable era is "latest", and an old pipeline can never be scored
 * under today's clustering rules. That conflates the two things a tuning run
 * must separate: how much of a delta came from changing the REVIEWER, and how
 * much from changing the MEASUREMENT. With both bounds, old and new eras are
 * scored by identical code and the difference is attributable to the pipeline.
 */
const ORVEX_UNTIL = process.env.BENCH_ORVEX_UNTIL ?? '';
const inOrvexEra = (at: string): boolean =>
  (!ORVEX_SINCE || at >= ORVEX_SINCE) && (!ORVEX_UNTIL || at < ORVEX_UNTIL);
const ORVEX_ERA_FILTERED = Boolean(ORVEX_SINCE || ORVEX_UNTIL);
const RESULTS_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'results');

const LOGIN_MAP: Record<string, string> = {
  'orvex-review[bot]': 'orvex',
  'chatgpt-codex-connector': 'codex',
  'chatgpt-codex-connector[bot]': 'codex',
  'qodo-code-review[bot]': 'qodo',
  'qodo-merge-pro[bot]': 'qodo',
  'coderabbitai[bot]': 'coderabbit',
  'gitar-bot[bot]': 'gitar',
  'greptile-apps[bot]': 'greptile',
};
function botOf(login: string): string | null {
  if (LOGIN_MAP[login]) return LOGIN_MAP[login];
  if (/gitar/i.test(login)) return 'gitar';
  if (/greptile/i.test(login)) return 'greptile';
  if (/coderabbit/i.test(login)) return 'coderabbit';
  if (/qodo/i.test(login)) return 'qodo';
  return null;
}

/** Orvex status posts (progress / summary headers) that are NOT findings. */
function isOrvexStatus(body: string): boolean {
  return isOrvexStatusComment(body);
}
/** CodeRabbit review availability, kept separate from "not observed". */
export type CodeRabbitState = 'reviewed' | 'rate_limited' | 'skipped';

/** CodeRabbit often posts a billing/limit notice instead of a review. Keep this
 * deliberately specific: a normal finding that discusses rate limiting must not
 * turn a genuine review into an unavailable run. */
export function coderabbitState(body: string): CodeRabbitState {
  if (
    /(?:review|pr|usage)\s+limits?\s+(?:reached|applied|exceeded)|next review available|rate[\s-]+limited\s+by\s+coderabbit|couldn['’]?t start this review|adaptive limits? (?:are|is) (?:currently )?applied|fair usage limits? policy/i.test(
      body,
    )
  ) {
    return 'rate_limited';
  }
  if (
    /review skipped|no new commits to review|no review (needed|required)|skipped due to|nothing to review|review was skipped/i.test(
      body,
    )
  )
    return 'skipped';
  return 'reviewed';
}

/** A rate-limit notice wins over historical review evidence for this snapshot:
 * the tool was unavailable for the benchmarked attempt, not a clean review. */
export function mergeCoderabbitState(
  current: CodeRabbitState | undefined,
  next: CodeRabbitState,
): CodeRabbitState {
  if (current === 'rate_limited' || next === 'rate_limited') return 'rate_limited';
  if (current === 'reviewed' || next === 'reviewed') return 'reviewed';
  return 'skipped';
}

interface Finding {
  pr: number;
  bot: string;
  path: string | null;
  line: number | null;
  sev: string | null;
  excerpt: string;
  /** Longer copy of the same body, used only for same-defect matching. The
   *  display excerpt is cut at 140 chars, which routinely truncates the one
   *  identifier that proves two tools are describing the same code. */
  matchText: string;
  /** true = mined from an INLINE review comment (every tool posts these);
   *  false = mined from Orvex's summary TABLE, which no competitor has an
   *  equivalent of in this harness. Tracked because the headline split is only
   *  apples-to-apples over anchored findings — see `pairwise`. */
  anchored: boolean;
}

/** Display length (unchanged) and the longer window kept for matching. */
const EXCERPT_CHARS = 140;
const MATCH_CHARS = 600;

/** Drop a bot's byte-identical re-reports of the same finding within one PR.
 *  Orvex's "previously reported, still open" table is re-emitted by EVERY
 *  subsequent review on a PR, and `collect` parses every review body, so a
 *  single defect was counted once per review. Cluster-based splits mostly
 *  absorbed that, but the raw per-tool finding counts and the severity
 *  distribution scaled with how many times we re-reviewed, not with how many
 *  defects existed. */
function dedupeRepeats(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.pr}|${f.bot}|${f.path ?? ''}|${f.line ?? ''}|${f.excerpt.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Pull confirmed findings out of an Orvex review-summary body. */
function parseOrvexTable(pr: number, body: string): Finding[] {
  return parseOrvexFindingTables(body, { strict: true }).map((finding) => ({
    pr,
    bot: 'orvex',
    path: finding.path,
    line: finding.line,
    sev: finding.severity,
    excerpt: finding.message.slice(0, EXCERPT_CHARS),
    matchText: finding.message.slice(0, MATCH_CHARS),
    anchored: false,
  }));
}

async function collect(octokit: Octokit) {
  const requestedPrNums: number[] = [];
  for (let n = PR_LO; n <= PR_HI; n++) requestedPrNums.push(n);
  const openPulls = await octokit.paginate(octokit.rest.pulls.list, {
    owner: OWNER,
    repo: REPO,
    state: 'open',
    per_page: 100,
  });
  const openNumbers = new Set(openPulls.map((pull) => pull.number));
  const prNums = requestedPrNums.filter((pr) => openNumbers.has(pr));
  const excluded = requestedPrNums.filter((pr) => !openNumbers.has(pr));
  if (excluded.length > 0) {
    console.log(`[collect] excluding ${excluded.length} non-open PR(s): ${excluded.join(', ')}`);
  }

  const findings: Finding[] = [];
  const reviewedPrs: Record<string, Set<number>> = {};
  const rateLimitedPrs: Record<string, Set<number>> = {};
  const skippedPrs: Record<string, Set<number>> = {};
  const orvexReviewedAt: Record<number, string> = {};
  /** PRs Orvex reviewed within the selected era (all of them when unset). */
  const orvexEraPrs = new Set<number>();
  const mark = (bot: string, pr: number) => (reviewedPrs[bot] ??= new Set()).add(pr);
  const markStatus = (bucket: Record<string, Set<number>>, bot: string, pr: number) =>
    (bucket[bot] ??= new Set()).add(pr);
  const seenLogins = new Set<string>();

  for (const pr of prNums) {
    const [rc, ic, rv] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner: OWNER,
        repo: REPO,
        pull_number: pr,
        per_page: 100,
      }),
      octokit.paginate(octokit.rest.issues.listComments, {
        owner: OWNER,
        repo: REPO,
        issue_number: pr,
        per_page: 100,
      }),
      octokit.paginate(octokit.rest.pulls.listReviews, {
        owner: OWNER,
        repo: REPO,
        pull_number: pr,
        per_page: 100,
      }),
    ]);

    // A tool "reviewed" a PR if it posted ANY review/comment on it — even with
    // zero findings (it looked and found nothing). CodeRabbit is the exception:
    // its "limit reached" / "review skipped" walkthroughs mean it did NOT review.
    const appeared = new Set<string>();

    // inline comments — anchored findings for every tool that posts them
    let crState: CodeRabbitState | undefined;
    for (const c of rc) {
      const login = c.user?.login ?? '';
      seenLogins.add(login);
      const bot = botOf(login);
      if (!bot) continue;
      appeared.add(bot);
      const body = c.body ?? '';
      if (bot === 'coderabbit') crState = mergeCoderabbitState(crState, coderabbitState(body));
      if (bot === 'orvex' && isOrvexStatus(body)) continue;
      if (bot === 'orvex' && !inOrvexEra(c.created_at ?? '')) continue;
      const flat = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      findings.push({
        pr,
        bot,
        path: c.path ?? null,
        line: c.line ?? c.original_line ?? null,
        sev: severityOf(body),
        excerpt: flat.slice(0, EXCERPT_CHARS),
        matchText: flat.slice(0, MATCH_CHARS),
        anchored: true,
      });
    }

    // review objects (greptile/codex/qodo/gitar post a review even with 0 findings)
    for (const r of rv) {
      const bot = botOf(r.user?.login ?? '');
      if (!bot) continue;
      appeared.add(bot);
      if (bot === 'coderabbit') {
        crState = mergeCoderabbitState(crState, coderabbitState(r.body ?? ''));
        continue;
      }
      if (bot === 'orvex') {
        const body = r.body ?? '';
        // Provenance: record the LATEST Orvex review time per PR so a combined
        // score can tell which prompt era produced the findings (Codex: eras were
        // mixed with no way to separate old vs new-prompt Orvex reviews).
        const at = r.submitted_at ?? '';
        if (at && at > (orvexReviewedAt[pr] ?? '')) orvexReviewedAt[pr] = at;
        if (!inOrvexEra(at)) continue;
        orvexEraPrs.add(pr);
        // Orvex's summary table. NOT anchored: no competitor has an equivalent
        // source in this harness, so these must not enter the headline split.
        for (const f of parseOrvexTable(pr, body)) findings.push({ ...f, anchored: false });
      }
    }

    // issue comments (summaries). CodeRabbit's state is decided here.
    let crReviewed = false;
    for (const c of ic) {
      const login = c.user?.login ?? '';
      seenLogins.add(login);
      const bot = botOf(login);
      if (!bot) continue;
      if (bot === 'coderabbit') {
        crState = mergeCoderabbitState(crState, coderabbitState(c.body ?? ''));
        if (crState === 'reviewed') crReviewed = true;
      } else appeared.add(bot);
    }

    for (const bot of appeared) if (bot !== 'coderabbit') mark(bot, pr);
    if (crState === 'rate_limited') markStatus(rateLimitedPrs, 'coderabbit', pr);
    else if (crState === 'skipped') markStatus(skippedPrs, 'coderabbit', pr);
    else if (crReviewed || crState === 'reviewed') mark('coderabbit', pr);
  }

  const deduped = dedupeRepeats(findings);
  if (deduped.length !== findings.length) {
    console.log(
      `[collect] dropped ${findings.length - deduped.length} repeated re-report(s) ` +
        `(same bot re-emitting one finding across multiple reviews on a PR)`,
    );
  }
  return {
    prNums,
    findings: deduped,
    reviewedPrs,
    rateLimitedPrs,
    skippedPrs,
    seenLogins,
    orvexReviewedAt,
    orvexEraPrs,
  };
}

interface Cluster {
  pr: number;
  path: string | null;
  line: number | null;
  bots: Set<string>;
  excerpt: string;
  sev: string | null;
  /** Severity as rated by EACH bot separately. The fused `sev` above is the
   *  cluster's worst rating across ALL tools — right for display, wrong for
   *  scoring. A cluster {orvex: P3, greptile: P1} fused to P1, and the qodo
   *  pairwise then counted it as an actionable ORVEX-ONLY bug: one Orvex
   *  itself called a nitpick, promoted by a severity donated by a third tool
   *  that is not even part of that comparison. The marquee "P1/P2 only (bugs)"
   *  row was the one most corrupted by it. */
  sevByBot: Map<string, string | null>;
  /** Every finding folded into this cluster, so a later finding can be matched
   *  against all of them rather than only the first one seen. */
  members: Finding[];
  /** Merges made on text evidence rather than line proximity, printed for
   *  hand audit — a wrong one fabricates `both caught` credit. */
  nearMatches: NearMatch[];
}

interface NearMatch {
  pr: number;
  path: string | null;
  reason: string;
  from: { bot: string; line: number | null; excerpt: string };
  to: { bot: string; line: number | null; excerpt: string };
}

/**
 * How far apart two anchors may sit and still be considered one defect on text
 * evidence. Generous because tools anchor to whichever statement they blame —
 * the guard against over-merging is `sameDefectText`, not distance.
 */
const NEAR_LINE_WINDOW = 400;

/** Same defect, different anchor: close enough in the file AND lexically proven. */
function nearDefectMatch(cluster: Cluster, f: Finding): NearMatch | null {
  if (f.line === null) return null;
  for (const member of cluster.members) {
    if (member.line === null) continue;
    if (Math.abs(member.line - f.line) > NEAR_LINE_WINDOW) continue;
    const verdict = sameDefectText(member.matchText, f.matchText);
    if (!verdict.match) continue;
    return {
      pr: f.pr,
      path: f.path,
      reason: verdict.reason,
      from: { bot: member.bot, line: member.line, excerpt: member.excerpt },
      to: { bot: f.bot, line: f.line, excerpt: f.excerpt },
    };
  }
  return null;
}

function clusterize(findings: Finding[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const f of findings) {
    let near: NearMatch | null = null;
    const hit = clusters.find((cl) => {
      if (cl.pr !== f.pr || cl.path !== f.path) return false;
      if (sameClusterLine(cl.line, f.line, cl.bots.has(f.bot))) return true;
      near = nearDefectMatch(cl, f);
      return near !== null;
    });
    if (hit) {
      hit.bots.add(f.bot);
      hit.sev = worseSev(hit.sev, f.sev);
      hit.sevByBot.set(f.bot, worseSev(hit.sevByBot.get(f.bot) ?? null, f.sev));
      hit.members.push(f);
      if (near) hit.nearMatches.push(near);
    } else {
      clusters.push({
        pr: f.pr,
        path: f.path,
        line: f.line,
        bots: new Set([f.bot]),
        excerpt: f.excerpt,
        sev: f.sev,
        sevByBot: new Map([[f.bot, f.sev]]),
        members: [f],
        nearMatches: [],
      });
    }
  }
  return clusters;
}

interface Split {
  both: number;
  compOnly: number;
  orvexOnly: number;
  total: number;
}
interface Pairwise {
  competitor: string;
  prs: number[];
  all: Split;
  actionable: Split;
  both: number;
  compOnly: number;
  orvexOnly: number;
  total: number;
}
/** Actionable WITHIN a specific head-to-head: only the two tools being compared
 *  may contribute severity — never the fused cross-tool `sev`. */
const isActionableFor = (c: Cluster, bot: string) => {
  const s = worseSev(c.sevByBot.get('orvex') ?? null, c.sevByBot.get(bot) ?? null);
  return s === 'P1' || s === 'P2';
};
function splitOf(bot: string, cls: Cluster[]): Split {
  return {
    total: cls.length,
    both: cls.filter((c) => c.bots.has('orvex') && c.bots.has(bot)).length,
    compOnly: cls.filter((c) => c.bots.has(bot) && !c.bots.has('orvex')).length,
    orvexOnly: cls.filter((c) => c.bots.has('orvex') && !c.bots.has(bot)).length,
  };
}
function pairwise(bot: string, prs: number[], clusters: Cluster[]): Pairwise {
  const cls = clusters.filter(
    (c) => prs.includes(c.pr) && (c.bots.has('orvex') || c.bots.has(bot)),
  );
  const all = splitOf(bot, cls);
  const actionable = splitOf(
    bot,
    cls.filter((c) => isActionableFor(c, bot)),
  );
  return { competitor: bot, prs, all, actionable, ...all };
}

interface Snapshot {
  schemaVersion: 2;
  measurement: {
    kind: 'competitor-coverage';
    headline: 'anchored-inline-only';
    orvexTableParser: 'strict-confirmed-v1';
  };
  batch: string;
  range: string;
  prLo: number;
  prHi: number;
  prNums: number[];
  runAt: string;
  pairwise: { all: Pairwise[]; anchored: Pairwise[] };
  availability?: Record<string, { reviewed: number[]; rateLimited: number[]; skipped: number[] }>;
}

function snapshotPairwiseRows(s: Snapshot, prefer: 'anchored' | 'all' = 'anchored'): Pairwise[] {
  if (prefer === 'anchored' && s.pairwise.anchored?.length) return s.pairwise.anchored;
  return s.pairwise.all ?? [];
}

export function isComparableSnapshot(value: unknown): value is Snapshot {
  const snapshot = value as Partial<Snapshot> | null;
  return Boolean(
    snapshot &&
      snapshot.schemaVersion === 2 &&
      snapshot.measurement?.kind === 'competitor-coverage' &&
      snapshot.measurement.headline === 'anchored-inline-only' &&
      snapshot.measurement.orvexTableParser === 'strict-confirmed-v1' &&
      !Array.isArray(snapshot.pairwise) &&
      Array.isArray(snapshot.pairwise?.anchored) &&
      Array.isArray(snapshot.pairwise?.all) &&
      Array.isArray(snapshot.prNums),
  );
}

function combine() {
  let files: string[] = [];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    /* none */
  }
  if (files.length === 0) {
    console.log('No saved snapshots in', RESULTS_DIR);
    return;
  }

  // 1) Load every snapshot; group by PR-range; keep only the LATEST per range
  //    (so re-runs of the same range never double-count).
  const byRange = new Map<string, Snapshot>();
  const quarantined: string[] = [];
  for (const file of files) {
    let s: Snapshot;
    try {
      s = JSON.parse(readFileSync(path.join(RESULTS_DIR, file), 'utf8')) as Snapshot;
    } catch {
      continue;
    }
    if (!isComparableSnapshot(s)) {
      quarantined.push(file);
      continue;
    }
    const prev = byRange.get(s.range);
    if (!prev || (s.runAt ?? '') > (prev.runAt ?? '')) byRange.set(s.range, s);
  }
  const chosen = [...byRange.values()];
  if (quarantined.length)
    console.log(
      `⚠️  Quarantined ${quarantined.length} incomparable snapshot(s): ${quarantined.join(', ')}`,
    );
  if (chosen.length === 0) {
    console.log(
      'No comparable v2 snapshots to combine; re-run the benchmark with explicit provenance.',
    );
    return;
  }

  // 2) REJECT overlapping ranges — a PR covered by two ranges would be counted
  //    twice. This is the exact integrity bug that made the combined total wrong.
  const seenPr = new Map<number, string>();
  const overlaps: string[] = [];
  for (const s of chosen)
    for (const pr of s.prNums) {
      if (seenPr.has(pr) && seenPr.get(pr) !== s.range)
        overlaps.push(`PR#${pr} in both ${seenPr.get(pr)} and ${s.range}`);
      else seenPr.set(pr, s.range);
    }
  if (overlaps.length) {
    console.error(
      `\n❌ REFUSING to combine — overlapping PR ranges double-count:\n  ${overlaps.slice(0, 8).join('\n  ')}`,
    );
    console.error(
      '  Fix: keep non-overlapping ranges (delete the redundant snapshot range and re-run).',
    );
    process.exitCode = 1;
    return;
  }

  const add = (a: Split, b: Split) => {
    a.both += b.both;
    a.compOnly += b.compOnly;
    a.orvexOnly += b.orvexOnly;
    a.total += b.total;
  };
  const zero = (): Split => ({ both: 0, compOnly: 0, orvexOnly: 0, total: 0 });
  const totals: Record<string, { all: Split; actionable: Split }> = {};
  const prsByComp: Record<string, Set<number>> = {};
  for (const s of chosen) {
    for (const p of snapshotPairwiseRows(s, 'anchored')) {
      const t = (totals[p.competitor] ??= { all: zero(), actionable: zero() });
      add(t.all, p.all);
      add(t.actionable, p.actionable);
      prsByComp[p.competitor] ??= new Set();
      for (const pr of p.prs) prsByComp[p.competitor].add(pr);
    }
  }
  console.log(
    `\nCOMBINED across ${chosen.length} range(s) [ANCHORED]: ${chosen.map((s) => `${s.range} (run ${s.runAt?.slice(0, 16)})`).join(', ')}\n`,
  );
  for (const c of COMPETITORS) {
    const t = totals[c];
    if (!t) continue;
    console.log(`Orvex vs ${c.padEnd(11)} — ${prsByComp[c].size} PRs`);
    console.log(
      `   ALL   both ${t.all.both} · ${c}-only(Orvex missed) ${t.all.compOnly} · Orvex-only ${t.all.orvexOnly}`,
    );
    console.log(
      `   BUGS  both ${t.actionable.both} · ${c}-only(Orvex missed) ${t.actionable.compOnly} · Orvex-only ${t.actionable.orvexOnly}`,
    );
  }
  console.log('');
}

async function main() {
  if (process.argv.includes('--combine')) {
    combine();
    return;
  }

  const octokit = await createBenchmarkOctokit(OWNER, REPO);

  const {
    prNums,
    findings,
    reviewedPrs,
    rateLimitedPrs,
    skippedPrs,
    seenLogins,
    orvexReviewedAt,
    orvexEraPrs,
  } = await collect(octokit);
  const clusters = clusterize(findings);

  // Restrict every head-to-head to PRs the selected Orvex era actually
  // reviewed; scoring a PR it never saw would read as a competitor win.
  const eraPrs = (prs: number[]) =>
    ORVEX_ERA_FILTERED ? prs.filter((pr) => orvexEraPrs.has(pr)) : prs;

  console.log(`\nCompetitor benchmark — ${OWNER}/${REPO} PRs #${PR_LO}–#${PR_HI}\n`);
  if (ORVEX_ERA_FILTERED) {
    const era = [...orvexEraPrs].sort((a, z) => a - z);
    const window = [
      ORVEX_SINCE ? `at/after ${ORVEX_SINCE}` : null,
      ORVEX_UNTIL ? `before ${ORVEX_UNTIL}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    console.log(`Orvex era filter: findings from reviews ${window}`);
    console.log(`  in-era PRs ${era.length}/${prNums.length}  [${era.join(', ') || 'none'}]\n`);
  }

  // Anchored ONLY. This row used to count every finding, so Orvex's summary-table
  // rows were added to its inline comments while competitors contributed inline
  // comments alone — Orvex read 3x noisier than it posts (PR#232: 8 inline + 20
  // table = "28"). Volume is the one thing this row is read for, so it has to be
  // like-for-like. Orvex's table total is shown separately, never fused in.
  console.log('Anchored (inline) findings per tool per PR:');
  const anchoredCount = (pr: number, bot: string) =>
    findings.filter((f) => f.pr === pr && f.bot === bot && f.anchored).length;
  for (const pr of prNums) {
    const row = ['orvex', ...COMPETITORS].map((b) => `${b}=${anchoredCount(pr, b)}`);
    const table = findings.filter((f) => f.pr === pr && f.bot === 'orvex' && !f.anchored).length;
    console.log(`  PR#${pr}:  ${row.join('  ')}   (orvex summary-table rows: ${table})`);
  }

  // Median inline comments per PR — the honest "how noisy is each tool" number.
  const median = (xs: number[]) => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, z) => a - z);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  console.log('\nInline comment volume (per PR the tool reviewed):');
  for (const b of ['orvex', ...COMPETITORS]) {
    const prs = [...(reviewedPrs[b] ?? [])];
    if (prs.length === 0) continue;
    const counts = prs.map((pr) => anchoredCount(pr, b));
    const total = counts.reduce((a, n) => a + n, 0);
    console.log(
      `  ${b.padEnd(11)} median ${String(median(counts)).padStart(4)}   mean ${(total / prs.length)
        .toFixed(1)
        .padStart(5)}   max ${String(Math.max(...counts)).padStart(3)}   total ${total}`,
    );
  }

  console.log('\nPRs each tool actually reviewed:');
  for (const b of ['orvex', ...COMPETITORS]) {
    const rp = [...(reviewedPrs[b] ?? [])].sort((a, z) => a - z);
    console.log(`  ${b.padEnd(11)} ${rp.length}/${prNums.length}  [${rp.join(', ') || 'none'}]`);
  }
  const crLimited = [...(rateLimitedPrs.coderabbit ?? [])].sort((a, z) => a - z);
  const crSkipped = [...(skippedPrs.coderabbit ?? [])].sort((a, z) => a - z);
  if (crLimited.length > 0) {
    console.log(
      `  coderabbit rate-limited ${crLimited.length}/${prNums.length}  [${crLimited.join(', ')}]`,
    );
  }
  if (crSkipped.length > 0) {
    console.log(
      `  coderabbit skipped     ${crSkipped.length}/${prNums.length}  [${crSkipped.join(', ')}]`,
    );
  }

  // Compare each competitor ONLY on the PRs it demonstrably reviewed — comparing
  // on PRs a bot never looked at would falsely credit Orvex a "win". greptile/
  // qodo/gitar/coderabbit post a review/walkthrough even on clean PRs, so their
  // reviewedPrs is accurate. NOTE: codex only posts when it FINDS something, so
  // its reviewedPrs is a LOWER BOUND — its "missed" is conservative (a PR where
  // codex silently reviewed-and-found-nothing is excluded, not counted as an
  // Orvex win we can't substantiate).
  // LIKE-FOR-LIKE split. Orvex contributes findings from two sources (inline
  // comments AND its summary table); every competitor contributes only inline
  // comments, because this harness has no parser for their prose bodies. That
  // asymmetry is not a small bias — an un-anchored Orvex row has line === null,
  // and `sameClusterLine` returns false whenever either side is null, so such a
  // row can NEVER cluster with a competitor finding no matter how well it
  // matches. Every one was therefore a guaranteed free `orvexOnly` that also
  // inflated `compOnly`. A prose-only tool scored 0 by construction.
  //
  // So the ANCHORED row below is the honest head-to-head; the ALL row is kept
  // for continuity but is Orvex-favourable by construction. Do not quote ALL.
  const anchoredClusters = clusterize(findings.filter((f) => f.anchored));
  const results: Pairwise[] = [];
  for (const c of COMPETITORS) {
    const prs = eraPrs([...(reviewedPrs[c] ?? [])].sort((a, z) => a - z));
    const p = pairwise(c, prs, clusters);
    const anchored = pairwise(c, prs, anchoredClusters);
    results.push(p);
    console.log(`\n=== Orvex vs ${c} — ${prs.length} PRs [${prs.join(', ')}] ===`);
    console.log(
      `  ANCHORED (compare) both ${anchored.all.both} · ${c}-only(ORVEX MISSED) ${anchored.all.compOnly} · Orvex-only ${anchored.all.orvexOnly} · total ${anchored.all.total}`,
    );
    console.log(
      `  ANCHORED P1/P2     both ${anchored.actionable.both} · ${c}-only(ORVEX MISSED) ${anchored.actionable.compOnly} · Orvex-only ${anchored.actionable.orvexOnly} · total ${anchored.actionable.total}`,
    );
    console.log(
      `  ALL findings       both ${p.all.both} · ${c}-only(ORVEX MISSED) ${p.all.compOnly} · Orvex-only ${p.all.orvexOnly} · total ${p.all.total}   [Orvex-favourable: includes table-only rows]`,
    );
    console.log(
      `  P1/P2 only (bugs)  both ${p.actionable.both} · ${c}-only(ORVEX MISSED) ${p.actionable.compOnly} · Orvex-only ${p.actionable.orvexOnly} · total ${p.actionable.total}   [same caveat]`,
    );
    if (anchored.all.total === 0 && p.all.total > 0) {
      console.log(
        `  ⚠ ${c} posts no line-anchored comments on these PRs — it CANNOT score above zero here.`,
      );
      console.log(`    Its numbers are a measurement artifact, not a capability result.`);
    }
  }

  // fine-tuning gold: what Orvex missed that a competitor caught
  console.log('\n──────── ORVEX MISSED (a competitor flagged, Orvex did not) ────────');
  const missed = clusters.filter(
    (c) =>
      !c.bots.has('orvex') &&
      [...c.bots].some((b) => (COMPETITORS as readonly string[]).includes(b)),
  );
  if (missed.length === 0) console.log('  (none)');
  for (const m of missed.sort((a, b) => a.pr - b.pr)) {
    console.log(
      `  PR#${m.pr} ${m.path ?? '?'}:${m.line ?? '?'} [${[...m.bots].join(',')}] ${m.sev ?? ''} — ${m.excerpt}`,
    );
  }

  // Audit surface for the text matcher. A wrong merge here invents a "both
  // caught" that never happened, so every one is printed with its evidence.
  console.log('\n──────── NEAR-MATCH MERGES (same defect, different anchor line) ────────');
  const nearMatches = clusters.flatMap((c) => c.nearMatches);
  if (nearMatches.length === 0) console.log('  (none)');
  for (const n of nearMatches.sort((a, b) => a.pr - b.pr)) {
    const crossTool = n.from.bot !== n.to.bot ? '' : '  [same tool — self-duplicate]';
    console.log(`  PR#${n.pr} ${n.path ?? '?'} — matched on ${n.reason}${crossTool}`);
    console.log(`      ${n.from.bot}:${n.from.line ?? '?'}  ${n.from.excerpt.slice(0, 110)}`);
    console.log(`      ${n.to.bot}:${n.to.line ?? '?'}  ${n.to.excerpt.slice(0, 110)}`);
  }

  console.log('\n──────── ORVEX UNIQUE (only Orvex flagged) ────────');
  const unique = clusters.filter((c) => c.bots.size === 1 && c.bots.has('orvex'));
  for (const u of unique.sort((a, b) => a.pr - b.pr)) {
    console.log(`  PR#${u.pr} ${u.path ?? '?'}:${u.line ?? '?'} ${u.sev ?? ''} — ${u.excerpt}`);
  }

  // Save as an IMMUTABLE, timestamped snapshot — NEVER overwrite a prior run.
  // Re-running a range as bots post more comments used to clobber the batch, so
  // `--combine` summed whatever happened to be on disk (the 30-vs-36 discrepancy
  // Codex caught). combine() now picks the latest snapshot per range and rejects
  // overlaps. Provenance: run time + latest Orvex-review time per PR (which
  // prompt era produced the reviewed findings).
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const runAt = new Date().toISOString();
    const stamp = runAt.replace(/[:.]/g, '-');
    // The era is part of the range identity. Two eras of the SAME PRs are two
    // different measurements of one population, never two batches to add up —
    // sharing a range key would let combine() silently pick whichever era ran
    // last. Distinct keys make its overlap guard reject the sum outright.
    const era = ORVEX_ERA_FILTERED
      ? `@${(ORVEX_SINCE || 'start').slice(0, 10)}_${(ORVEX_UNTIL || 'now').slice(0, 10)}`
      : '';
    const range = `${PR_LO}-${PR_HI}${era}`;
    const fname = `${OWNER}_${REPO}_${range.replace(/[^\w.@-]/g, '_')}__${stamp}.json`;
    writeFileSync(
      path.join(RESULTS_DIR, fname),
      JSON.stringify(
        {
          schemaVersion: 2,
          measurement: {
            kind: 'competitor-coverage',
            headline: 'anchored-inline-only',
            orvexTableParser: 'strict-confirmed-v1',
          },
          batch: `${OWNER}_${REPO}_${range}`,
          range,
          prLo: PR_LO,
          prHi: PR_HI,
          prNums,
          runAt,
          // Which Orvex prompt era these findings came from; null = every era
          // present on the PRs, which fuses pipelines and cannot show a delta.
          orvexSince: ORVEX_SINCE || null,
          orvexUntil: ORVEX_UNTIL || null,
          orvexEraPrs: [...orvexEraPrs].sort((a, z) => a - z),
          orvexReviewedAt,
          availability: {
            coderabbit: {
              reviewed: [...(reviewedPrs.coderabbit ?? [])].sort((a, z) => a - z),
              rateLimited: crLimited,
              skipped: crSkipped,
            },
          },
          // Persist BOTH splits. ANCHORED is the honest head-to-head; ALL is
          // Orvex-favourable (includes summary-table-only rows). Tune quality
          // only against anchored.
          pairwise: {
            all: results,
            anchored: COMPETITORS.map((c) => {
              const prs = eraPrs([...(reviewedPrs[c] ?? [])].sort((a, z) => a - z));
              return pairwise(c, prs, anchoredClusters);
            }),
          },
        },
        null,
        2,
      ),
    );
    console.log(
      `\nSaved immutable snapshot → results/${fname}  (run with --combine to sum latest-per-range)`,
    );
  } catch (e) {
    console.warn('could not save batch:', (e as Error).message);
  }

  console.log('\nlogins seen:', [...seenLogins].join(', '));
  console.log('CAVEAT: coverage, not correctness. CodeRabbit posts prose-only summaries (no');
  console.log('line-level comments) on these PRs, so its anchored count is ~0 by design.\n');
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
