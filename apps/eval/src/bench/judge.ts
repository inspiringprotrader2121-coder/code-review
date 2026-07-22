/**
 * Precision-judge pass (ROADMAP Phase 7). The competitor benchmark measures
 * COVERAGE — it can't tell a real bug from a false positive. After the severity
 * fix made Orvex much more assertive (#124: 2→11 findings), we must confirm the
 * recall gain didn't buy noise. This reads every ORVEX-ONLY actionable (P1/P2)
 * finding — the riskiest, since no competitor corroborated it — fetches the real
 * code around it, and has an independent skeptical model rule real vs false.
 *
 *   ORVEX_INSTALL_ID=144378482 BENCH_PR_LO=124 BENCH_PR_HI=128 tsx src/bench/judge.ts
 */
import { llmChat } from '@orvex-review/review';
import { createBenchmarkOctokit } from './github-auth.js';
import { severityOf, worseSev, sameClusterLine } from './severity.js';

const OWNER = process.env.BENCH_OWNER ?? 'inspiringprotrader2121-coder';
const REPO = process.env.BENCH_REPO ?? 'Velatrix-Cloud';
const PR_LO = Number(process.env.BENCH_PR_LO ?? 124);
const PR_HI = Number(process.env.BENCH_PR_HI ?? 128);
// Only judge Orvex reviews from AFTER the new-prompt deploy.
const CUTOFF = process.env.BENCH_CUTOFF ?? '2026-07-12T17:20:00Z';

const LOGIN_MAP: Record<string, string> = {
  'orvex-review[bot]': 'orvex', 'chatgpt-codex-connector[bot]': 'codex', 'chatgpt-codex-connector': 'codex',
  'qodo-code-review[bot]': 'qodo', 'coderabbitai[bot]': 'coderabbit', 'gitar-bot[bot]': 'gitar', 'greptile-apps[bot]': 'greptile',
};
const botOf = (l: string) => LOGIN_MAP[l] ?? (/gitar/i.test(l) ? 'gitar' : /greptile/i.test(l) ? 'greptile' : /qodo/i.test(l) ? 'qodo' : /coderabbit/i.test(l) ? 'coderabbit' : null);
const isOrvexStatus = (b: string) => /^(🔄|✅|⏳)|\*\*Applying|\*\*Fix applied|^## Orvex Review|already reviewed|safety limit/i.test(b.trim());
/** Anchored severity parse (label region, not free text) — shared module. */
const sevOf = severityOf;

interface Finding { pr: number; bot: string; path: string | null; line: number | null; sev: string | null; text: string; }

function llmEnv() {
  const k = process.env.MINIMAX_API_KEY;
  if (!k) throw new Error('MINIMAX_API_KEY required');
  return { apiKey: k, baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1', model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3' };
}

async function main() {
  const octokit = await createBenchmarkOctokit(OWNER, REPO);
  const llm = llmEnv();

  const findings: Finding[] = [];
  const headSha: Record<number, string> = {};
  const fileCache = new Map<string, string>();

  for (let pr = PR_LO; pr <= PR_HI; pr++) {
    const { data } = await octokit.rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: pr });
    headSha[pr] = data.head.sha;
    const [rc, rv] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviewComments, { owner: OWNER, repo: REPO, pull_number: pr, per_page: 100 }),
      octokit.paginate(octokit.rest.pulls.listReviews, { owner: OWNER, repo: REPO, pull_number: pr, per_page: 100 }),
    ]);
    for (const c of rc) {
      const bot = botOf(c.user?.login ?? '');
      if (!bot) continue;
      const body = c.body ?? '';
      // Orvex findings: only NEW-prompt ones (post-cutoff). Competitors: any (for corroboration).
      if (bot === 'orvex' && (isOrvexStatus(body) || (c.created_at ?? '') < CUTOFF)) continue;
      findings.push({ pr, bot, path: c.path ?? null, line: c.line ?? c.original_line ?? null, sev: sevOf(body), text: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
    }
    // Orvex summary-table findings (new-prompt reviews only)
    for (const r of rv) {
      if (botOf(r.user?.login ?? '') !== 'orvex') continue;
      if ((r.submitted_at ?? '') < CUTOFF) continue;
      for (const line of (r.body ?? '').split('\n')) {
        const m = /^\|\s*(P[0-3]|info)\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
        if (!m) continue;
        const ref = /^(.+?):(\d+)$/.exec(m[2].trim());
        findings.push({ pr, bot: 'orvex', path: ref ? ref[1] : m[2].trim(), line: ref ? Number(ref[2]) : null, sev: m[1].toUpperCase(), text: m[3].trim() });
      }
    }
  }

  // cluster file+line ±5; a competitor within the cluster = corroborated.
  // Unanchored (null-line) findings only cluster within the SAME bot. Cluster
  // severity MAX-FOLDS — a cluster holding an Orvex P2 must judge as P2 even if
  // a P3 copy was seen first (first-non-null used to mask it out of judging).
  interface C { pr: number; path: string | null; line: number | null; bots: Set<string>; orvexText: string; sev: string | null; }
  const clusters: C[] = [];
  for (const f of findings) {
    const hit = clusters.find((c) => c.pr === f.pr && c.path === f.path && sameClusterLine(c.line, f.line, c.bots.has(f.bot)));
    if (hit) { hit.bots.add(f.bot); if (f.bot === 'orvex' && f.text.length > hit.orvexText.length) hit.orvexText = f.text; hit.sev = worseSev(hit.sev, f.sev); }
    else clusters.push({ pr: f.pr, path: f.path, line: f.line, bots: new Set([f.bot]), orvexText: f.bot === 'orvex' ? f.text : '', sev: f.sev });
  }

  // Orvex-only, actionable (P1/P2), with a locatable anchor
  const toJudge = clusters.filter((c) => c.bots.has('orvex') && c.bots.size === 1 && (c.sev === 'P1' || c.sev === 'P2') && c.path && c.orvexText);
  console.log(`\nPrecision-judge — ${OWNER}/${REPO} #${PR_LO}-#${PR_HI} (new-prompt reviews after ${CUTOFF})`);
  console.log(`Orvex-only P1/P2 findings to judge: ${toJudge.length}\n`);

  const getWindow = async (pr: number, path: string, line: number | null): Promise<string> => {
    const key = `${pr}:${path}`;
    let content = fileCache.get(key);
    if (content === undefined) {
      try {
        const { data } = await octokit.rest.repos.getContent({ owner: OWNER, repo: REPO, path, ref: headSha[pr] });
        content = !Array.isArray(data) && data.type === 'file' && data.content ? Buffer.from(data.content, 'base64').toString('utf8') : '';
      } catch { content = ''; }
      fileCache.set(key, content);
    }
    if (!content) return '(file not fetchable)';
    const lines = content.split('\n');
    if (line == null) return lines.slice(0, 80).map((l, i) => `${i + 1}: ${l}`).join('\n').slice(0, 6000);
    const lo = Math.max(0, line - 30), hi = Math.min(lines.length, line + 30);
    return lines.slice(lo, hi).map((l, i) => `${lo + i + 1}: ${l}`).join('\n').slice(0, 6000);
  };

  let real = 0, uncertain = 0, falsePos = 0;
  const falses: string[] = [];
  for (const c of toJudge) {
    const code = await getWindow(c.pr, c.path!, c.line);
    const system = 'You are a skeptical principal engineer independently judging whether a code-review finding is a REAL, actionable bug at the indicated location, or a false positive. Judge ONLY against the code shown. A real bug: a concrete correctness/security/reliability defect a competent reviewer would fix. NOT real: speculation the code contradicts, a style/nitpick dressed up, a claim about code not shown, or a hazard the shown code already handles. Reply strict JSON only: {"verdict":"real"|"false"|"uncertain","reason":"<=15 words"}.';
    const user = `Finding (Orvex, ${c.sev}) at ${c.path}:${c.line ?? '?'}:\n${c.orvexText.slice(0, 500)}\n\nCode around that location:\n\`\`\`\n${code}\n\`\`\``;
    let verdict = 'uncertain', reason = '';
    try {
      const raw = await llmChat(system, user, { ...llm, thinking: false, maxTokens: 200 });
      const m = raw.match(/\{[\s\S]*\}/);
      const p = m ? JSON.parse(m[0]) : null;
      verdict = p?.verdict ?? 'uncertain'; reason = p?.reason ?? '';
    } catch (e) { reason = `judge error: ${(e as Error).message}`; }
    if (verdict === 'real') real++;
    else if (verdict === 'false') { falsePos++; falses.push(`  ✗ #${c.pr} ${c.path}:${c.line} [${c.sev}] — ${reason} :: ${c.orvexText.slice(0, 80)}`); }
    else uncertain++;
    console.log(`${verdict === 'real' ? '✅' : verdict === 'false' ? '❌' : '❔'} #${c.pr} ${c.path?.split('/').pop()}:${c.line} ${c.sev} — ${reason}`);
  }

  const judged = real + falsePos; // exclude uncertain from the ratio
  const precision = judged ? Math.round((real / judged) * 100) : 0;
  console.log('\n── precision on Orvex-only P1/P2 findings ──');
  console.log(`real: ${real} · false: ${falsePos} · uncertain: ${uncertain}`);
  console.log(`precision (real / (real+false)) = ${precision}%`);
  if (falses.length) { console.log('\nfalse positives:'); console.log(falses.join('\n')); }
  console.log('\nNote: judge = MiniMax (same family as the verifier), so this is a sanity check, not a fully independent oracle. Corroborated findings (a competitor agreed) are assumed real and not re-judged.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
