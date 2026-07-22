/**
 * Severity-integrity audit (ROADMAP Phase 7). Answers two questions directly:
 *   1. Is Orvex still burying REAL bugs in nitpicks? → UNDER-SEVERITY: Orvex rated
 *      a cluster P3/info that ≥1 competitor rated P1/P2.
 *   2. Is Orvex getting bug severity wrong the other way? → OVER-SEVERITY: Orvex
 *      rated P1/P2 but every competitor who flagged the same spot rated it P3/info.
 * Also prints Orvex's severity distribution (nitpick rate) for the batch.
 *
 *   ORVEX_INSTALL_ID=144378482 BENCH_PR_LO=129 BENCH_PR_HI=138 tsx src/bench/severity-check.ts
 */
import { createBenchmarkOctokit } from './github-auth.js';
import { severityOf, sevRank as rank, isBugSev as isBug, isNitSev as isNit, sameClusterLine } from './severity.js';

const OWNER = process.env.BENCH_OWNER ?? 'inspiringprotrader2121-coder';
const REPO = process.env.BENCH_REPO ?? 'Velatrix-Cloud';
const PR_LO = Number(process.env.BENCH_PR_LO ?? 129);
const PR_HI = Number(process.env.BENCH_PR_HI ?? 138);

const LOGIN_MAP: Record<string, string> = {
  'orvex-review[bot]': 'orvex', 'chatgpt-codex-connector[bot]': 'codex', 'chatgpt-codex-connector': 'codex',
  'qodo-code-review[bot]': 'qodo', 'coderabbitai[bot]': 'coderabbit', 'gitar-bot[bot]': 'gitar', 'greptile-apps[bot]': 'greptile',
};
const botOf = (l: string) => LOGIN_MAP[l] ?? (/gitar/i.test(l) ? 'gitar' : /greptile/i.test(l) ? 'greptile' : /qodo/i.test(l) ? 'qodo' : /coderabbit/i.test(l) ? 'coderabbit' : null);
const isOrvexStatus = (b: string) => /^(🔄|✅|⏳)|\*\*Applying|\*\*Fix applied|^## Orvex Review|already reviewed|safety limit/i.test(b.trim());

/** Anchored severity parse (label region, not free text) — shared module. */
const sevOf = severityOf;

interface F { pr: number; bot: string; path: string | null; line: number | null; sev: string | null; text: string; }

async function main() {
  const octokit = await createBenchmarkOctokit(OWNER, REPO);
  const findings: F[] = [];

  for (let pr = PR_LO; pr <= PR_HI; pr++) {
    const [rc, rv] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviewComments, { owner: OWNER, repo: REPO, pull_number: pr, per_page: 100 }),
      octokit.paginate(octokit.rest.pulls.listReviews, { owner: OWNER, repo: REPO, pull_number: pr, per_page: 100 }),
    ]);
    for (const c of rc) {
      const bot = botOf(c.user?.login ?? '');
      if (!bot) continue;
      const body = c.body ?? '';
      if (bot === 'orvex' && isOrvexStatus(body)) continue;
      findings.push({ pr, bot, path: c.path ?? null, line: c.line ?? c.original_line ?? null, sev: sevOf(body), text: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120) });
    }
    // Orvex severities live in its summary TABLE + collapsed nitpicks section
    for (const r of rv) {
      if (botOf(r.user?.login ?? '') !== 'orvex') continue;
      for (const line of (r.body ?? '').split('\n')) {
        const m = /^\|\s*(P[0-3]|info)\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
        if (!m) continue;
        const ref = /^(.+?):(\d+)$/.exec(m[2].trim());
        findings.push({ pr, bot: 'orvex', path: ref ? ref[1] : m[2].trim(), line: ref ? Number(ref[2]) : null, sev: m[1].toUpperCase() === 'INFO' ? 'info' : m[1].toUpperCase(), text: m[3].slice(0, 120) });
      }
    }
  }

  // cluster by pr+file+line(±5); unanchored (null-line) findings only cluster
  // within the SAME bot — cross-tool null==null merged unrelated defects.
  interface C { pr: number; path: string | null; line: number | null; orvex: F | null; comps: F[]; }
  const clusters: C[] = [];
  for (const f of findings) {
    const sameBot = (c: C) => (f.bot === 'orvex' ? c.orvex !== null : c.comps.some((x) => x.bot === f.bot));
    let hit = clusters.find((c) => c.pr === f.pr && c.path === f.path && sameClusterLine(c.line, f.line, sameBot(c)));
    if (!hit) { hit = { pr: f.pr, path: f.path, line: f.line, orvex: null, comps: [] }; clusters.push(hit); }
    if (f.bot === 'orvex') { if (!hit.orvex || rank(f.sev) > rank(hit.orvex.sev)) hit.orvex = f; }
    else hit.comps.push(f);
  }

  // Orvex severity distribution
  const dist: Record<string, number> = { P1: 0, P2: 0, P3: 0, info: 0, unknown: 0 };
  for (const f of findings.filter((x) => x.bot === 'orvex')) dist[f.sev ?? 'unknown']++;
  const orvexTotal = Object.values(dist).reduce((a, b) => a + b, 0);
  const nitRate = orvexTotal ? Math.round(((dist.P3 + dist.info) / orvexTotal) * 100) : 0;

  console.log(`\nSeverity-integrity audit — ${OWNER}/${REPO} #${PR_LO}-#${PR_HI}\n`);
  console.log(`Orvex severity DISTRIBUTION: P1=${dist.P1} P2=${dist.P2} P3=${dist.P3} info=${dist.info} unknown=${dist.unknown}`);
  console.log(`  → P3+info share = ${nitRate}% of findings. NOTE: this is a distribution, NOT a noise/annoyance`);
  console.log(`     rate — P3/info are already COLLAPSED out of inline comments (filter.ts), shown folded in`);
  console.log(`     the summary. Whether they're USEFUL vs noise needs real signals (ignored / reaction /`);
  console.log(`     accepted-fix / code-changed), not this count.\n`);

  const compBug = (c: C) => c.comps.filter((x) => isBug(x.sev));
  const compMax = (c: C) => c.comps.reduce((m, x) => Math.max(m, rank(x.sev)), 0);

  // 1) UNDER-SEVERITY: Orvex nitpicked (P3/info) something ≥1 competitor called a bug (P1/P2)
  const under = clusters.filter((c) => c.orvex && isNit(c.orvex.sev) && compBug(c).length > 0);
  console.log(`──────── ⚠️ UNDER-SEVERITY: Orvex NITPICKED a bug a competitor flagged P1/P2 (${under.length}) ────────`);
  if (!under.length) console.log('  ✅ none — Orvex is not burying competitor-confirmed bugs in nitpicks');
  for (const c of under.sort((a, b) => a.pr - b.pr)) {
    const who = compBug(c).map((x) => `${x.bot}:${x.sev}`).join(',');
    console.log(`  #${c.pr} ${c.path}:${c.line} — Orvex ${c.orvex!.sev} vs [${who}] :: ${c.orvex!.text}`);
  }

  // 2) OVER-SEVERITY: Orvex P1/P2 where EVERY competitor who flagged it rated P3/info (crying wolf on severity)
  const over = clusters.filter((c) => c.orvex && isBug(c.orvex.sev) && c.comps.length > 0 && compMax(c) <= 1);
  console.log(`\n──────── ⚠️ OVER-SEVERITY: Orvex rated P1/P2 but all competitors nitpicked it (${over.length}) ────────`);
  if (!over.length) console.log('  ✅ none — Orvex is not inflating nitpicks into bugs');
  for (const c of over.sort((a, b) => a.pr - b.pr)) {
    const who = c.comps.map((x) => `${x.bot}:${x.sev ?? '?'}`).join(',');
    console.log(`  #${c.pr} ${c.path}:${c.line} — Orvex ${c.orvex!.sev} vs [${who}] :: ${c.orvex!.text}`);
  }

  // 3) agreement sanity: Orvex bug + a competitor bug at the same spot
  const agree = clusters.filter((c) => c.orvex && isBug(c.orvex.sev) && compBug(c).length > 0).length;
  console.log(`\n──────── AGREEMENT: Orvex P1/P2 corroborated by a competitor P1/P2: ${agree} ────────`);
  console.log('\n(Coverage/who-caught-what is competitors.ts; this audit is specifically about Orvex severity bucketing.)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
