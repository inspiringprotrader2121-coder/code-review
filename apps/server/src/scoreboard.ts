import type { createInstallationOctokit } from '@orvex-review/github';

type Octokit = ReturnType<typeof createInstallationOctokit>;

/**
 * Competitive scoreboard (ROADMAP Phase 1) — mines the repo's own PRs, where
 * multiple review bots (Orvex, OpenAI's codex connector, Qodo, CodeRabbit…)
 * comment side by side, and scores who caught what. Pure GitHub-API reads:
 * no LLM calls, ~$0 to rebuild.
 *
 * Findings are INLINE review comments by known bots (plus Orvex's PR-level
 * unanchored-finding comments), clustered by file + line proximity: a cluster
 * where others commented but Orvex didn't = an Orvex miss — the raw material
 * for new rules/lenses (the ESM __dirname rule came from exactly one of these).
 */

const KNOWN_BOTS: Record<string, string> = {
  'orvex-review[bot]': 'orvex',
  'chatgpt-codex-connector': 'codex',
  'chatgpt-codex-connector[bot]': 'codex',
  'qodo-code-review[bot]': 'qodo',
  'qodo-merge-pro[bot]': 'qodo',
  'coderabbitai[bot]': 'coderabbit',
};

export interface ScoreFinding {
  pr: number;
  bot: string;
  path: string | null;
  line: number | null;
  severity: string | null;
  excerpt: string;
}

export interface ScoreCluster {
  pr: number;
  path: string | null;
  line: number | null;
  bots: string[];
  severity: string | null;
  excerpt: string;
}

export interface Scoreboard {
  generatedAt: string;
  repo: string;
  /** sha256 of rules/orvex-rules.md at build time — ties this snapshot to the
   *  exact ruleset that produced these reviews' most recent era. Compare
   *  snapshots with different hashes to see whether a config change helped. */
  rulesHash?: string;
  /** catch-rate trend: the newest half of analyzed PRs vs the older half —
   *  shows whether the CURRENT config era is out/under-performing the past
   *  without needing to diff snapshots manually. */
  trend?: {
    recent: { prs: number; clusters: number; orvexCatchPct: number };
    older: { prs: number; clusters: number; orvexCatchPct: number };
  };
  prsAnalyzed: number;
  bots: Record<string, { findings: number; prsWithFindings: number; clustersHit: number; uniqueClusters: number }>;
  clusters: { total: number; orvexMissed: ScoreCluster[]; orvexUnique: ScoreCluster[] };
  perPr: Array<{ pr: number; title: string; state: string; counts: Record<string, number> }>;
}

function severityOf(body: string): string | null {
  const p = /\b(P[0-3])\b/.exec(body);
  if (p) return p[1];
  if (/critical/i.test(body)) return 'P1';
  if (/\bmajor\b/i.test(body)) return 'P2';
  if (/\bminor\b|\bnitpick\b/i.test(body)) return 'P3';
  if (/potential issue/i.test(body)) return 'P2';
  return null;
}

/** Orvex posts non-finding status comments (apply-fix progress, summaries) —
 *  exclude anything that isn't a finding so its counts aren't inflated. */
function isOrvexNonFinding(body: string): boolean {
  return /^(🔄|✅|⏳)|\*\*Applying this fix|\*\*Fix applied|Reviewed .*#\d+ @/.test(body.trim());
}

export async function buildScoreboard(
  octokit: Octokit,
  owner: string,
  repo: string,
  maxPrs: number,
): Promise<Scoreboard> {
  const prs = (
    await octokit.paginate(octokit.rest.pulls.list, {
      owner,
      repo,
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: 100,
    })
  ).slice(0, maxPrs);

  const findings: ScoreFinding[] = [];
  const perPr: Scoreboard['perPr'] = [];

  for (const pr of prs) {
    const counts: Record<string, number> = {};
    // inline review comments — the primary finding surface for every bot
    const reviewComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });
    for (const c of reviewComments) {
      const bot = KNOWN_BOTS[c.user?.login ?? ''];
      if (!bot) continue;
      if (bot === 'orvex' && isOrvexNonFinding(c.body ?? '')) continue;
      findings.push({
        pr: pr.number,
        bot,
        path: c.path ?? null,
        line: c.line ?? c.original_line ?? null,
        severity: severityOf(c.body ?? ''),
        excerpt: (c.body ?? '').replace(/\s+/g, ' ').slice(0, 160),
      });
      counts[bot] = (counts[bot] ?? 0) + 1;
    }
    // PR-level comments: Orvex's unanchored findings (start with **P1**/**P2**/…)
    const issueComments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    for (const c of issueComments) {
      const bot = KNOWN_BOTS[c.user?.login ?? ''];
      if (!bot) continue;
      const body = c.body ?? '';
      if (!/^\*\*(P[0-3]|info)\*\*/.test(body.trim())) continue; // findings only, not summaries
      const fileMatch = /`([^`]+?)(?::(\d+))?`/.exec(body);
      findings.push({
        pr: pr.number,
        bot,
        path: fileMatch?.[1] ?? null,
        line: fileMatch?.[2] ? Number(fileMatch[2]) : null,
        severity: severityOf(body),
        excerpt: body.replace(/\s+/g, ' ').slice(0, 160),
      });
      counts[bot] = (counts[bot] ?? 0) + 1;
    }
    perPr.push({ pr: pr.number, title: pr.title, state: pr.merged_at ? 'merged' : pr.state, counts });
  }

  // Cluster: same PR + same file + line within ±5 = the same defect.
  const clusters: Array<{ key: ScoreCluster; members: ScoreFinding[] }> = [];
  for (const f of findings) {
    const hit = clusters.find(
      (cl) =>
        cl.key.pr === f.pr &&
        cl.key.path === f.path &&
        ((cl.key.line === null && f.line === null) ||
          (cl.key.line !== null && f.line !== null && Math.abs(cl.key.line - f.line) <= 5)),
    );
    if (hit) {
      hit.members.push(f);
      if (!hit.key.bots.includes(f.bot)) hit.key.bots.push(f.bot);
      if (!hit.key.severity && f.severity) hit.key.severity = f.severity;
    } else {
      clusters.push({
        key: { pr: f.pr, path: f.path, line: f.line, bots: [f.bot], severity: f.severity, excerpt: f.excerpt },
        members: [f],
      });
    }
  }

  const botNames = [...new Set(findings.map((f) => f.bot))];
  const bots: Scoreboard['bots'] = {};
  for (const b of botNames) {
    const own = findings.filter((f) => f.bot === b);
    bots[b] = {
      findings: own.length,
      prsWithFindings: new Set(own.map((f) => f.pr)).size,
      clustersHit: clusters.filter((cl) => cl.key.bots.includes(b)).length,
      uniqueClusters: clusters.filter((cl) => cl.key.bots.length === 1 && cl.key.bots[0] === b).length,
    };
  }

  // Trend: newest half of PRs vs older half — a config regression shows up as
  // recent catch% < older catch% even inside a single snapshot.
  const prNums = prs.map((p) => p.number).sort((a, b) => b - a);
  const cut = prNums[Math.floor(prNums.length / 2)] ?? 0;
  const bucket = (filter: (pr: number) => boolean) => {
    const cl = clusters.filter((c) => filter(c.key.pr));
    const hit = cl.filter((c) => c.key.bots.includes('orvex')).length;
    return {
      prs: prNums.filter(filter).length,
      clusters: cl.length,
      orvexCatchPct: cl.length ? Math.round((100 * hit) / cl.length) : 0,
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    repo: `${owner}/${repo}`,
    trend: { recent: bucket((n) => n >= cut), older: bucket((n) => n < cut) },
    prsAnalyzed: prs.length,
    bots,
    clusters: {
      total: clusters.length,
      // the recall report: defects other bots flagged that Orvex didn't
      orvexMissed: clusters.filter((cl) => !cl.key.bots.includes('orvex')).map((cl) => cl.key),
      // the marketing report: defects ONLY Orvex flagged
      orvexUnique: clusters.filter((cl) => cl.key.bots.length === 1 && cl.key.bots[0] === 'orvex').map((cl) => cl.key),
    },
    perPr,
  };
}
