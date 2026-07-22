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
 *   - Orvex's review-summary TABLE rows (Orvex posts un-anchored findings there,
 *     with `path:line`, instead of inline — must be parsed or Orvex is undercounted)
 *   - CodeRabbit posts prose walkthroughs with NO line-level comments on these PRs,
 *     so its anchored count is ~0 and that is reported honestly, not hidden.
 *
 * Findings are clustered (same PR + file + line within ±5) into candidate defects.
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
import { fileURLToPath } from 'node:url';
import type { Octokit } from '@octokit/rest';
import { createBenchmarkOctokit } from './github-auth.js';
import { severityOf, worseSev, sameClusterLine } from './severity.js';

const OWNER = process.env.BENCH_OWNER ?? 'inspiringprotrader2121-coder';
const REPO = process.env.BENCH_REPO ?? 'Velatrix-Cloud';
const PR_LO = Number(process.env.BENCH_PR_LO ?? 114);
const PR_HI = Number(process.env.BENCH_PR_HI ?? 123);
const COMPETITORS = ['codex', 'greptile', 'coderabbit', 'qodo', 'gitar'] as const;
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
  return /^(🔄|✅|⏳)|\*\*Applying|\*\*Fix applied|^## Orvex Review|already reviewed|safety limit/i.test(body.trim());
}
/** CodeRabbit review state: it often can't/doesn't post a real review. A
 *  walkthrough is only "reviewed" when it isn't one of the known no-review
 *  notices — expanded after under-counting real skips as reviews. */
function coderabbitState(body: string): 'reviewed' | 'limit' | 'skipped' {
  if (/limit reached|couldn.t start this review|rate.?limit|usage limit/i.test(body)) return 'limit';
  if (/review skipped|no new commits to review|no review (needed|required)|skipped due to|nothing to review|review was skipped/i.test(body)) return 'skipped';
  return 'reviewed';
}

interface Finding { pr: number; bot: string; path: string | null; line: number | null; sev: string | null; excerpt: string; }

/** Parse `path:line` (or `path`) from an Orvex table cell like `` `a/b.js:12` ``. */
function parseFileRef(ref: string): { path: string | null; line: number | null } {
  const m = /^(.+?):(\d+)$/.exec(ref.trim());
  if (m) return { path: m[1], line: Number(m[2]) };
  return { path: ref.trim() || null, line: null };
}

/** Pull findings out of an Orvex review-summary body (table rows carry file:line). */
function parseOrvexTable(pr: number, body: string): Finding[] {
  const out: Finding[] = [];
  for (const line of body.split('\n')) {
    // | P2 | `path:line` | message |   (also nitpicks + still-open tables)
    const m = /^\|\s*(P[0-3]|info)\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const { path: p, line: ln } = parseFileRef(m[2]);
    out.push({ pr, bot: 'orvex', path: p, line: ln, sev: m[1].toUpperCase(), excerpt: m[3].slice(0, 140) });
  }
  return out;
}

async function collect(octokit: Octokit) {
  const prNums: number[] = [];
  for (let n = PR_LO; n <= PR_HI; n++) prNums.push(n);

  const findings: Finding[] = [];
  const reviewedPrs: Record<string, Set<number>> = {};
  const orvexReviewedAt: Record<number, string> = {};
  const mark = (bot: string, pr: number) => (reviewedPrs[bot] ??= new Set()).add(pr);
  const seenLogins = new Set<string>();

  for (const pr of prNums) {
    const [rc, ic, rv] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviewComments, { owner: OWNER, repo: REPO, pull_number: pr, per_page: 100 }),
      octokit.paginate(octokit.rest.issues.listComments, { owner: OWNER, repo: REPO, issue_number: pr, per_page: 100 }),
      octokit.paginate(octokit.rest.pulls.listReviews, { owner: OWNER, repo: REPO, pull_number: pr, per_page: 100 }),
    ]);

    // A tool "reviewed" a PR if it posted ANY review/comment on it — even with
    // zero findings (it looked and found nothing). CodeRabbit is the exception:
    // its "limit reached" / "review skipped" walkthroughs mean it did NOT review.
    const appeared = new Set<string>();

    // inline comments — anchored findings for every tool that posts them
    for (const c of rc) {
      const login = c.user?.login ?? '';
      seenLogins.add(login);
      const bot = botOf(login);
      if (!bot) continue;
      appeared.add(bot);
      const body = c.body ?? '';
      if (bot === 'orvex' && isOrvexStatus(body)) continue;
      findings.push({ pr, bot, path: c.path ?? null, line: c.line ?? c.original_line ?? null, sev: severityOf(body), excerpt: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 140) });
    }

    // review objects (greptile/codex/qodo/gitar post a review even with 0 findings)
    for (const r of rv) {
      const bot = botOf(r.user?.login ?? '');
      if (!bot) continue;
      appeared.add(bot);
      if (bot === 'orvex') {
        const body = r.body ?? '';
        // Provenance: record the LATEST Orvex review time per PR so a combined
        // score can tell which prompt era produced the findings (Codex: eras were
        // mixed with no way to separate old vs new-prompt Orvex reviews).
        const at = r.submitted_at ?? '';
        if (at && at > (orvexReviewedAt[pr] ?? '')) orvexReviewedAt[pr] = at;
        for (const f of parseOrvexTable(pr, body)) findings.push(f); // un-anchored findings live in Orvex's table
      }
    }

    // issue comments (summaries). CodeRabbit's state is decided here.
    let crReviewed = false;
    for (const c of ic) {
      const login = c.user?.login ?? '';
      seenLogins.add(login);
      const bot = botOf(login);
      if (!bot) continue;
      if (bot === 'coderabbit') { if (coderabbitState(c.body ?? '') === 'reviewed') crReviewed = true; }
      else appeared.add(bot);
    }

    for (const bot of appeared) if (bot !== 'coderabbit') mark(bot, pr);
    if (crReviewed) mark('coderabbit', pr);
  }

  return { prNums, findings, reviewedPrs, seenLogins, orvexReviewedAt };
}

interface Cluster { pr: number; path: string | null; line: number | null; bots: Set<string>; excerpt: string; sev: string | null; }
function clusterize(findings: Finding[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const f of findings) {
    const hit = clusters.find(
      (cl) => cl.pr === f.pr && cl.path === f.path && sameClusterLine(cl.line, f.line, cl.bots.has(f.bot)),
    );
    if (hit) { hit.bots.add(f.bot); hit.sev = worseSev(hit.sev, f.sev); }
    else clusters.push({ pr: f.pr, path: f.path, line: f.line, bots: new Set([f.bot]), excerpt: f.excerpt, sev: f.sev });
  }
  return clusters;
}

interface Split { both: number; compOnly: number; orvexOnly: number; total: number; }
interface Pairwise { competitor: string; prs: number[]; all: Split; actionable: Split; both: number; compOnly: number; orvexOnly: number; total: number; }
const isActionable = (c: Cluster) => c.sev === 'P1' || c.sev === 'P2';
function splitOf(bot: string, cls: Cluster[]): Split {
  return {
    total: cls.length,
    both: cls.filter((c) => c.bots.has('orvex') && c.bots.has(bot)).length,
    compOnly: cls.filter((c) => c.bots.has(bot) && !c.bots.has('orvex')).length,
    orvexOnly: cls.filter((c) => c.bots.has('orvex') && !c.bots.has(bot)).length,
  };
}
function pairwise(bot: string, prs: number[], clusters: Cluster[]): Pairwise {
  const cls = clusters.filter((c) => prs.includes(c.pr) && (c.bots.has('orvex') || c.bots.has(bot)));
  const all = splitOf(bot, cls);
  const actionable = splitOf(bot, cls.filter(isActionable));
  return { competitor: bot, prs, all, actionable, ...all };
}

interface Snapshot { batch: string; range: string; prLo: number; prHi: number; prNums: number[]; runAt: string; pairwise: Pairwise[]; }

function combine() {
  let files: string[] = [];
  try { files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  if (files.length === 0) { console.log('No saved snapshots in', RESULTS_DIR); return; }

  // 1) Load every snapshot; group by PR-range; keep only the LATEST per range
  //    (so re-runs of the same range never double-count).
  const byRange = new Map<string, Snapshot>();
  const legacy: string[] = [];
  for (const file of files) {
    let s: Snapshot;
    try { s = JSON.parse(readFileSync(path.join(RESULTS_DIR, file), 'utf8')) as Snapshot; } catch { continue; }
    if (!s.range || !Array.isArray(s.prNums)) { legacy.push(file); continue; } // pre-hygiene file — skip, don't silently sum
    const prev = byRange.get(s.range);
    if (!prev || (s.runAt ?? '') > (prev.runAt ?? '')) byRange.set(s.range, s);
  }
  const chosen = [...byRange.values()];
  if (legacy.length) console.log(`⚠️  Ignoring ${legacy.length} legacy/overwritable snapshot(s) without range metadata: ${legacy.join(', ')}`);
  if (chosen.length === 0) { console.log('No hygiene-compliant snapshots to combine (re-run the benchmark to produce timestamped ones).'); return; }

  // 2) REJECT overlapping ranges — a PR covered by two ranges would be counted
  //    twice. This is the exact integrity bug that made the combined total wrong.
  const seenPr = new Map<number, string>();
  const overlaps: string[] = [];
  for (const s of chosen) for (const pr of s.prNums) {
    if (seenPr.has(pr) && seenPr.get(pr) !== s.range) overlaps.push(`PR#${pr} in both ${seenPr.get(pr)} and ${s.range}`);
    else seenPr.set(pr, s.range);
  }
  if (overlaps.length) {
    console.error(`\n❌ REFUSING to combine — overlapping PR ranges double-count:\n  ${overlaps.slice(0, 8).join('\n  ')}`);
    console.error('  Fix: keep non-overlapping ranges (delete the redundant snapshot range and re-run).');
    process.exitCode = 1;
    return;
  }

  const add = (a: Split, b: Split) => { a.both += b.both; a.compOnly += b.compOnly; a.orvexOnly += b.orvexOnly; a.total += b.total; };
  const zero = (): Split => ({ both: 0, compOnly: 0, orvexOnly: 0, total: 0 });
  const totals: Record<string, { all: Split; actionable: Split }> = {};
  const prsByComp: Record<string, Set<number>> = {};
  for (const s of chosen) {
    for (const p of s.pairwise) {
      const t = (totals[p.competitor] ??= { all: zero(), actionable: zero() });
      add(t.all, p.all); add(t.actionable, p.actionable);
      (prsByComp[p.competitor] ??= new Set());
      for (const pr of p.prs) prsByComp[p.competitor].add(pr);
    }
  }
  console.log(`\nCOMBINED across ${chosen.length} range(s): ${chosen.map((s) => `${s.range} (run ${s.runAt?.slice(0, 16)})`).join(', ')}\n`);
  for (const c of COMPETITORS) {
    const t = totals[c]; if (!t) continue;
    console.log(`Orvex vs ${c.padEnd(11)} — ${prsByComp[c].size} PRs`);
    console.log(`   ALL   both ${t.all.both} · ${c}-only(Orvex missed) ${t.all.compOnly} · Orvex-only ${t.all.orvexOnly}`);
    console.log(`   BUGS  both ${t.actionable.both} · ${c}-only(Orvex missed) ${t.actionable.compOnly} · Orvex-only ${t.actionable.orvexOnly}`);
  }
  console.log('');
}

async function main() {
  if (process.argv.includes('--combine')) { combine(); return; }

  const octokit = await createBenchmarkOctokit(OWNER, REPO);

  const { prNums, findings, reviewedPrs, seenLogins, orvexReviewedAt } = await collect(octokit);
  const clusters = clusterize(findings);

  console.log(`\nCompetitor benchmark — ${OWNER}/${REPO} PRs #${PR_LO}–#${PR_HI}\n`);

  console.log('Anchored findings per tool per PR:');
  for (const pr of prNums) {
    const row = ['orvex', ...COMPETITORS].map((b) => `${b}=${findings.filter((f) => f.pr === pr && f.bot === b).length}`);
    console.log(`  PR#${pr}:  ${row.join('  ')}`);
  }

  console.log('\nPRs each tool actually reviewed:');
  for (const b of ['orvex', ...COMPETITORS]) {
    const rp = [...(reviewedPrs[b] ?? [])].sort((a, z) => a - z);
    console.log(`  ${b.padEnd(11)} ${rp.length}/${prNums.length}  [${rp.join(', ') || 'none'}]`);
  }

  // Compare each competitor ONLY on the PRs it demonstrably reviewed — comparing
  // on PRs a bot never looked at would falsely credit Orvex a "win". greptile/
  // qodo/gitar/coderabbit post a review/walkthrough even on clean PRs, so their
  // reviewedPrs is accurate. NOTE: codex only posts when it FINDS something, so
  // its reviewedPrs is a LOWER BOUND — its "missed" is conservative (a PR where
  // codex silently reviewed-and-found-nothing is excluded, not counted as an
  // Orvex win we can't substantiate).
  const results: Pairwise[] = [];
  for (const c of COMPETITORS) {
    const prs = [...(reviewedPrs[c] ?? [])].sort((a, z) => a - z);
    const p = pairwise(c, prs, clusters);
    results.push(p);
    console.log(`\n=== Orvex vs ${c} — ${prs.length} PRs [${prs.join(', ')}] ===`);
    console.log(`  ALL findings       both ${p.all.both} · ${c}-only(ORVEX MISSED) ${p.all.compOnly} · Orvex-only ${p.all.orvexOnly} · total ${p.all.total}`);
    console.log(`  P1/P2 only (bugs)  both ${p.actionable.both} · ${c}-only(ORVEX MISSED) ${p.actionable.compOnly} · Orvex-only ${p.actionable.orvexOnly} · total ${p.actionable.total}`);
  }

  // fine-tuning gold: what Orvex missed that a competitor caught
  console.log('\n──────── ORVEX MISSED (a competitor flagged, Orvex did not) ────────');
  const missed = clusters.filter((c) => !c.bots.has('orvex') && [...c.bots].some((b) => (COMPETITORS as readonly string[]).includes(b)));
  if (missed.length === 0) console.log('  (none)');
  for (const m of missed.sort((a, b) => a.pr - b.pr)) {
    console.log(`  PR#${m.pr} ${m.path ?? '?'}:${m.line ?? '?'} [${[...m.bots].join(',')}] ${m.sev ?? ''} — ${m.excerpt}`);
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
    const range = `${PR_LO}-${PR_HI}`;
    const fname = `${OWNER}_${REPO}_${range}__${stamp}.json`;
    writeFileSync(
      path.join(RESULTS_DIR, fname),
      JSON.stringify({ batch: `${OWNER}_${REPO}_${range}`, range, prLo: PR_LO, prHi: PR_HI, prNums, runAt, orvexReviewedAt, pairwise: results }, null, 2),
    );
    console.log(`\nSaved immutable snapshot → results/${fname}  (run with --combine to sum latest-per-range)`);
  } catch (e) { console.warn('could not save batch:', (e as Error).message); }

  console.log('\nlogins seen:', [...seenLogins].join(', '));
  console.log('CAVEAT: coverage, not correctness. CodeRabbit posts prose-only summaries (no');
  console.log('line-level comments) on these PRs, so its anchored count is ~0 by design.\n');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
