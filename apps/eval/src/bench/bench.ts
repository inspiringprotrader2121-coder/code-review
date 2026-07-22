/**
 * Ground-truth reversion benchmark.
 *
 * For each real bug-FIX commit in a set of popular public repos, we reverse the
 * fix's diff so the *buggy* code appears as newly-added lines, run Orvex's static
 * review core over it, and check whether it flags a real (P1/P2) issue at the
 * exact location the maintainer fixed. The fix is the objective ground truth — a
 * human confirmed a real bug there — so this needs no open PRs and no competitor
 * cooperation. It measures the reviewer's RECALL on confirmed real bugs.
 *
 * Scope note: this exercises the static reviewer (rules + multi-model + verifier)
 * on the diff. It does NOT include Verify's sandbox code-execution, so it is a
 * conservative LOWER BOUND on Orvex's real catch rate.
 *
 * Run where the LLM + (optional) GitHub token live:
 *   pnpm --filter @orvex-review/eval bench            # ~15 cases, default repos
 *   BENCH_CASES=30 BENCH_TOKEN=$GH_PAT pnpm --filter @orvex-review/eval bench
 */
import { Octokit } from '@octokit/rest';
import {
  dropSelfNegatingFindings,
  llmChat,
  llmFindingsToReviewFindings,
  runLlmReview,
  verifyFindings,
  type ReviewFinding,
} from '@orvex-review/review';
import { reversePatch, type ReversedHunkRange } from './reverse-diff.js';

// Popular, well-maintained public repos whose bug-fix commits are real, diverse,
// and externally credible. Kept language-diverse on purpose.
const BENCH_REPOS: Array<{ owner: string; repo: string }> = [
  { owner: 'expressjs', repo: 'express' },
  { owner: 'axios', repo: 'axios' },
  { owner: 'vercel', repo: 'next.js' },
  { owner: 'facebook', repo: 'react' },
  { owner: 'nodejs', repo: 'node' },
  { owner: 'pallets', repo: 'flask' },
  { owner: 'psf', repo: 'requests' },
  { owner: 'gin-gonic', repo: 'gin' },
];

// Commit-message signals that a change is a genuine BUG fix (not a feature,
// refactor, doc, or chore). Kept high-precision so the corpus stays real bugs.
const BUGFIX_RE =
  /\b(fix(e[sd])?|bug|crash|npe|null[- ]?(deref|pointer)|leak|race|deadlock|overflow|underflow|off[- ]by[- ]one|incorrect|wrong|regression|segfault|use[- ]after[- ]free|double[- ]free|cve-\d)/i;
// Non-bug categories to drop from the corpus. Leading \b anchors the word start
// (so "latest" isn't caught by "test"); \w* lets suffixes through ("deprecated",
// "reverted", "docs") — the trailing-\b version silently leaked those.
const EXCLUDE_RE =
  /\b(typo|doc|readme|comment|test|lint|format|prettier|style|whitespace|bump|version|changelog|workflow|rename|refactor|cleanup|deprecat|revert|chore|upgrade|backport|polyfill)\w*/i;

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|c|cc|cpp|h|hpp|rs|php)$/;

const MAX_FILES = 3; // a focused bug fix, not a sweeping change
const MAX_CHANGED_LINES = 40; // small enough to be one clear defect
const MATCH_WINDOW = 8; // a finding within N lines of the fix counts as caught

interface BenchCase {
  owner: string;
  repo: string;
  sha: string;
  /** the commit BEFORE the fix — i.e. the buggy tree, for fetching real context */
  parentSha: string;
  message: string;
  files: Array<{ path: string; patch: string; ranges: ReversedHunkRange[] }>;
}

function llmEnv() {
  const minimax = process.env.MINIMAX_API_KEY;
  if (minimax) {
    return {
      apiKey: minimax,
      baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1',
      model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3',
    };
  }
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (!anthropic) throw new Error('MINIMAX_API_KEY or ANTHROPIC_API_KEY required');
  return { apiKey: anthropic, baseUrl: undefined, model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514' };
}

/**
 * Corpus-quality gate. A commit message matching /fix/ is NOT proof of a
 * reviewable bug — the auto-discovered set is full of logging tweaks, CSS,
 * type-syntax churn, unreachable-code removals, and cross-language ports. This
 * asks the model to confirm the change fixes a GENUINE bug a reviewer could
 * catch by reading the diff. Defaults to REJECT on any doubt, to keep the
 * benchmark corpus honest (a smaller, clean corpus beats a big, noisy one).
 */
async function isRealBug(
  llm: ReturnType<typeof llmEnv>,
  message: string,
  patches: string,
): Promise<{ ok: boolean; reason: string }> {
  const system =
    'You are a strict triage classifier for a code-review benchmark. Decide whether this commit fixes a GENUINE software BUG that a reviewer could catch by reading the changed code — a logic error, security flaw, crash, race condition, incorrect result, resource leak, or unhandled edge case. Answer NO for: logging/print changes; formatting, style, CSS, or UI-layout changes; comments or docs; type-annotation or type-syntax changes; dependency or version bumps; deprecation cleanups; removing unreachable or dead code; test-only changes; cross-language ports; config or build changes; and pure refactors with no behavior change. Reply ONLY as JSON: {"bug": true|false, "reason": "<=10 words"}.';
  const user = `Commit message: ${message}\n\nDiff:\n${patches.slice(0, 6000)}`;
  try {
    const raw = await llmChat(system, user, { ...llm, thinking: false, maxTokens: 200 });
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { bug?: boolean; reason?: string }) : null;
    return { ok: parsed?.bug === true, reason: parsed?.reason ?? 'unparseable' };
  } catch {
    return { ok: false, reason: 'classifier error' };
  }
}

async function discoverCases(
  octokit: Octokit,
  llm: ReturnType<typeof llmEnv>,
  target: number,
): Promise<BenchCase[]> {
  const cases: BenchCase[] = [];
  const perRepo = Math.max(2, Math.ceil(target / BENCH_REPOS.length) + 1);

  for (const { owner, repo } of BENCH_REPOS) {
    if (cases.length >= target) break;
    let candidates: Array<{ sha: string; message: string }> = [];
    try {
      const { data } = await octokit.rest.repos.listCommits({ owner, repo, per_page: 100 });
      candidates = data
        .map((c) => ({ sha: c.sha, message: (c.commit.message ?? '').split('\n')[0] }))
        .filter((c) => BUGFIX_RE.test(c.message) && !EXCLUDE_RE.test(c.message));
    } catch (err) {
      console.warn(`  ! ${owner}/${repo}: listCommits failed (${(err as Error).message})`);
      continue;
    }

    let kept = 0;
    for (const cand of candidates) {
      if (kept >= perRepo || cases.length >= target) break;
      try {
        const { data: commit } = await octokit.rest.repos.getCommit({ owner, repo, ref: cand.sha });
        const files = commit.files ?? [];
        const totalChanges = files.reduce((a, f) => a + (f.changes ?? 0), 0);
        if (files.length > MAX_FILES || totalChanges > MAX_CHANGED_LINES) continue;
        const codeFiles = files.filter(
          (f) => f.patch && f.status === 'modified' && CODE_EXT.test(f.filename),
        );
        if (codeFiles.length === 0) continue;

        // Corpus gate: confirm this is a real, reviewable bug before spending a
        // full review on it. Classify on the ACTUAL fix diff (not reversed).
        const fixDiff = codeFiles.map((f) => `--- ${f.filename}\n${f.patch}`).join('\n\n');
        const verdict = await isRealBug(llm, cand.message, fixDiff);
        if (!verdict.ok) {
          console.log(`  – skip ${owner}/${repo}@${cand.sha.slice(0, 7)} (not a bug: ${verdict.reason})`);
          continue;
        }

        const revFiles = codeFiles.map((f) => {
          const { patch, ranges } = reversePatch(f.patch!);
          return { path: f.filename, patch, ranges };
        });
        const parentSha = commit.parents?.[0]?.sha ?? cand.sha;
        cases.push({ owner, repo, sha: cand.sha, parentSha, message: cand.message, files: revFiles });
        kept++;
      } catch {
        /* skip unreadable commit */
      }
    }
  }
  return cases;
}

async function reviewReversed(
  c: BenchCase,
  llm: ReturnType<typeof llmEnv>,
  octokit: Octokit,
): Promise<ReviewFinding[]> {
  // Fetch the FULL buggy file (the parent tree), so the reviewer sees the
  // surrounding logic exactly as production Orvex does — not just the hunk.
  // Best-effort: if the fetch is rate-limited, fall back to diff-only.
  const changedContents: Array<{ path: string; content: string }> = [];
  for (const f of c.files) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: c.owner,
        repo: c.repo,
        path: f.path,
        ref: c.parentSha,
      });
      if (!Array.isArray(data) && data.type === 'file' && data.content) {
        changedContents.push({
          path: f.path,
          content: Buffer.from(data.content, 'base64').toString('utf8').slice(0, 60_000),
        });
      }
    } catch {
      /* rate-limited or unreadable — diff-only for this file */
    }
  }

  const resp = await runLlmReview(
    c.files.map((f) => ({ filename: f.path, status: 'modified' as const, patch: f.patch })),
    {
      ...llm,
      context: {
        prTitle: 'Code change under review',
        prBody: 'Review the changed code below for correctness, security, and concurrency bugs.',
        changedContents,
      },
    },
  );
  let findings = llmFindingsToReviewFindings(resp.findings);
  findings = dropSelfNegatingFindings(findings).kept;
  // Verify against the full buggy files (fall back to the diff), same strict
  // filter the real pipeline uses, so false positives don't inflate "findings".
  const ctxFiles = changedContents.length > 0 ? changedContents : c.files.map((f) => ({ path: f.path, content: f.patch }));
  if (ctxFiles.length > 0 && findings.length > 0) {
    findings = (await verifyFindings(findings, ctxFiles, { ...llm })).kept;
  }
  return findings;
}

function caught(c: BenchCase, findings: ReviewFinding[]): { hit: boolean; where?: string } {
  for (const f of findings) {
    if (f.severity !== 'P1' && f.severity !== 'P2') continue; // nitpicks don't count as catching a bug
    const base = f.file.split('/').pop();
    for (const cf of c.files) {
      if (cf.path.split('/').pop() !== base) continue;
      if (f.line == null) continue;
      for (const r of cf.ranges) {
        const lo = r.start - MATCH_WINDOW;
        const hi = r.start + Math.max(r.count, 1) + MATCH_WINDOW;
        if (f.line >= lo && f.line <= hi) return { hit: true, where: `${f.severity} ${f.file}:${f.line}` };
      }
    }
  }
  return { hit: false };
}

async function main() {
  const target = Number(process.env.BENCH_CASES ?? 15);
  const token = process.env.BENCH_TOKEN ?? process.env.GITHUB_BENCH_TOKEN ?? process.env.GH_PAT;
  const octokit = new Octokit(token ? { auth: token } : {});
  const llm = llmEnv();

  console.log(`\nGround-truth reversion benchmark — target ${target} real bug-fix cases`);
  console.log(`Model: ${llm.model}${token ? '' : '  (GitHub unauthenticated — set BENCH_TOKEN to avoid rate limits)'}\n`);

  const cases = await discoverCases(octokit, llm, target);
  console.log(`Discovered ${cases.length} bug-fix cases across ${BENCH_REPOS.length} repos.\n`);

  let hits = 0;
  const rows: string[] = [];
  for (const c of cases) {
    process.stdout.write(`▶ ${c.owner}/${c.repo}@${c.sha.slice(0, 7)} — "${c.message.slice(0, 54)}" … `);
    try {
      const findings = await reviewReversed(c, llm, octokit);
      const res = caught(c, findings);
      if (res.hit) hits++;
      console.log(`${res.hit ? '✅ caught' : '❌ missed'} (${findings.length} findings)${res.where ? ' → ' + res.where : ''}`);
      rows.push(`${res.hit ? '✅' : '❌'}  ${c.owner}/${c.repo}@${c.sha.slice(0, 7)}  ${c.message.slice(0, 60)}`);
    } catch (err) {
      console.log(`ERROR ${(err as Error).message}`);
      rows.push(`⚠️  ${c.owner}/${c.repo}@${c.sha.slice(0, 7)}  (error)`);
    }
  }

  const pct = cases.length ? Math.round((hits / cases.length) * 100) : 0;
  console.log('\n── summary ──');
  console.log(rows.join('\n'));
  console.log(`\nRecall on confirmed real bugs: ${hits}/${cases.length} = ${pct}%`);
  console.log('(static reviewer only — excludes Verify sandbox execution, so a lower bound)\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
