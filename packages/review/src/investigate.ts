import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { buildUserPrompt, loadOrvexRules, type ReviewPromptContext } from './prompt.js';
import { redactPatch, redactSecrets } from './redact.js';
import { extractJsonLoose, llmChat, type LlmAttemptEvent } from './llm-client.js';
import { LlmReviewResponseSchema, type LlmReviewResponse, type ReviewableFile } from './types.js';
import { normalizeLlmResponse, REVIEW_INCOMPLETE_SUMMARY, isTransientLlmError } from './llm.js';
import { safePromptData } from './prompt-safety.js';

const execFileAsync = promisify(execFile);

/**
 * Sandboxed investigate tier — model-agnostic tool loop over a repo checkout.
 *
 * Unlike Codex CLI (`--dangerously-bypass-approvals-and-sandbox` + shell), this
 * path only exposes read-only, path-confined tools: list_dir / read_file / grep.
 * No arbitrary shell, no network, no writes. Safe enough to run without the
 * Codex first-party allowlist when a checkout is available.
 */

export interface InvestigateOptions {
  /** Absolute path to a repo checkout. All tool paths are confined under this. */
  cwd: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
  /** Cancel the tool loop and any active provider call when the PR closes. */
  signal?: AbortSignal;
  context?: ReviewPromptContext;
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    provider?: string;
    model?: string;
    attemptId?: string;
  }) => void;
  onAttempt?: (event: LlmAttemptEvent) => void;
  /** Max tool rounds before forcing a done response. Default 8. */
  maxSteps?: number;
  /** Cap on a single tool result returned to the model. */
  maxToolOutputChars?: number;
}

const ToolCallSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('list_dir'),
    path: z.string().default('.'),
  }),
  z.object({
    name: z.literal('read_file'),
    path: z.string().min(1),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  }),
  z.object({
    name: z.literal('grep'),
    pattern: z.string().min(1).max(400),
    path: z.string().optional(),
    glob: z.string().max(120).optional(),
    caseInsensitive: z.boolean().optional(),
  }),
]);

const StepSchema = z.union([
  z.object({
    action: z.literal('tool'),
    tool: ToolCallSchema,
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('done'),
    findings: z.array(z.unknown()).optional(),
    summary: z.string().optional(),
  }),
]);

function finiteEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function defaultMaxSteps(): number {
  return Math.max(1, Math.min(20, Math.floor(finiteEnv(process.env.ORVEX_INVESTIGATE_MAX_STEPS, 8))));
}

function defaultMaxToolChars(): number {
  return Math.max(2_000, Math.min(80_000, Math.floor(finiteEnv(process.env.ORVEX_INVESTIGATE_TOOL_CHARS, 24_000))));
}

/**
 * Resolve `rel` under `root` with symlink escape protection.
 * Returns null when the path would leave the checkout.
 */
export function resolveUnderRoot(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  // Absolute tool paths are refused — agents must use checkout-relative paths.
  if (path.isAbsolute(rel)) return null;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return null;
  }
  const candidate = path.resolve(rootReal, rel);
  // Reject obvious escapes before realpath (missing files still need confinement).
  const relToRoot = path.relative(rootReal, candidate);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;

  try {
    const real = fs.realpathSync(candidate);
    const realRel = path.relative(rootReal, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
    return real;
  } catch {
    // Path does not exist yet (e.g. list_dir on a typo) — still confine via resolve.
    return candidate;
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated, ${text.length - max} chars omitted)`;
}

async function toolListDir(root: string, rel: string, maxChars: number): Promise<string> {
  const dir = resolveUnderRoot(root, rel || '.');
  if (!dir) return 'ERROR: path escapes checkout or is invalid';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lines = entries
      .slice(0, 400)
      .map((e) => `${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : 'f'} ${e.name}`)
      .join('\n');
    const more = entries.length > 400 ? `\n… (${entries.length - 400} more entries omitted)` : '';
    return clip(redactSecrets(lines + more) || '(empty)', maxChars);
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}

async function toolReadFile(
  root: string,
  rel: string,
  offset: number | undefined,
  limit: number | undefined,
  maxChars: number,
): Promise<string> {
  const file = resolveUnderRoot(root, rel);
  if (!file) return 'ERROR: path escapes checkout or is invalid';
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return 'ERROR: not a regular file';
    const maxBytes = Math.min(st.size, finiteEnv(process.env.ORVEX_INVESTIGATE_FILE_BYTES, 250_000));
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      let text = buf.slice(0, read).toString('utf8');
      // Redact BEFORE line prefixes — ^-anchored secret rules miss `12|secret_key_base: …`.
      text = redactSecrets(text);
      const start = Math.max(0, offset ?? 0);
      const lines = text.split('\n');
      const slice = limit !== undefined ? lines.slice(start, start + limit) : lines.slice(start);
      text = slice.map((line, i) => `${start + i + 1}|${line}`).join('\n');
      if (st.size > maxBytes) text += `\n… (file truncated at ${maxBytes} bytes)`;
      return clip(text, maxChars);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}

/** Validate a grep pattern is safe for rg (no `--` flag injection via pattern). */
export function isSafeGrepPattern(pattern: string): boolean {
  if (!pattern || pattern.length > 400) return false;
  // Refuse patterns that look like CLI flags when placed after `--`.
  if (/^--/.test(pattern)) return false;
  return true;
}

export function isSafeGlob(glob: string | undefined): boolean {
  if (glob === undefined || glob === '') return true;
  if (glob.length > 120) return false;
  // No path separators that could escape; no null; no leading dashes for flag injection.
  if (glob.includes('\0') || /^--/.test(glob)) return false;
  return true;
}

/** Grep hits often lack surrounding context that multi-line redact rules need. */
function redactGrepOutput(text: string): string {
  // Strip `path:line:` prefixes, redact the content, then reassemble — otherwise
  // ^-anchored redact rules miss `cfg.yml:1:secret_key_base: …`.
  return text
    .split('\n')
    .map((line) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (m) return `${m[1]}:${m[2]}:${redactSecrets(m[3])}`;
      return redactSecrets(line);
    })
    .join('\n')
    .replace(
      // Standalone k8s value lines (rg often returns only the value line).
      /^([^\n]*?:\d+:[ \t]*value:[ \t]*)(['"]?)([^\s'"\r\n]{6,})\2/gim,
      '$1$2[REDACTED]$2',
    )
    .replace(/^([ \t]*value:[ \t]*)(['"]?)([^\s'"\r\n]{6,})\2/gim, '$1$2[REDACTED]$2');
}

async function toolGrep(
  root: string,
  pattern: string,
  rel: string | undefined,
  glob: string | undefined,
  caseInsensitive: boolean | undefined,
  maxChars: number,
): Promise<string> {
  if (!isSafeGrepPattern(pattern)) return 'ERROR: invalid grep pattern';
  if (!isSafeGlob(glob)) return 'ERROR: invalid glob';

  let searchPath = root;
  if (rel) {
    const resolved = resolveUnderRoot(root, rel);
    if (!resolved) return 'ERROR: path escapes checkout or is invalid';
    searchPath = resolved;
  }

  const args = [
    '-n',
    '--no-heading',
    '--color',
    'never',
    '--max-count',
    '40',
    '--max-filesize',
    '256K',
  ];
  if (caseInsensitive) args.push('-i');
  if (glob) args.push('--glob', glob);
  // `--` so a pattern starting with `-` cannot be parsed as a flag.
  args.push('--', pattern, searchPath);

  try {
    const { stdout, stderr } = await execFileAsync('rg', args, {
      timeout: 12_000,
      maxBuffer: 512_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME, LANG: process.env.LANG },
    });
    const out = (stdout || stderr || '(no matches)').trim() || '(no matches)';
    // Whole-buffer + grep-specific redaction, then checkout-relative paths.
    const redactedOut = redactGrepOutput(out);
    const rootReal = fs.realpathSync(root);
    const rewritten = redactedOut
      .split('\n')
      .map((line) => (line.startsWith(rootReal) ? line.slice(rootReal.length).replace(/^\//, '') : line))
      .join('\n');
    return clip(rewritten, maxChars);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    // rg exits 1 when no matches — treat as empty, not failure.
    if (Number(e.code) === 1) return '(no matches)';
    if (e.code === 'ENOENT') {
      return 'ERROR: ripgrep (rg) is not installed on this worker — cannot grep';
    }
    const fallback = (e.stdout || e.stderr || e.message || 'grep failed').toString();
    return clip(redactSecrets(fallback), maxChars);
  }
}

export async function runInvestigateTool(
  root: string,
  tool: z.infer<typeof ToolCallSchema>,
  maxChars: number,
): Promise<string> {
  switch (tool.name) {
    case 'list_dir':
      return toolListDir(root, tool.path, maxChars);
    case 'read_file':
      return toolReadFile(root, tool.path, tool.offset, tool.limit, maxChars);
    case 'grep':
      return toolGrep(root, tool.pattern, tool.path, tool.glob, tool.caseInsensitive, maxChars);
    default:
      return 'ERROR: unknown tool';
  }
}

const INVESTIGATE_SYSTEM_EXTRA = `
## Investigate mode (tool loop) — OUTPUT FORMAT OVERRIDE
Ignore any instruction elsewhere to return bare {"findings":...} JSON as your first reply.
You MUST use the tool protocol below until you finish investigating.

You have READ-ONLY tools over a full checkout of the repository at HEAD of this PR.
Your job is P1/P2 recall via multi-hop search — not breadth nits.

Hunt these miss classes first (historically where single-shot reviews go blind):
1. Resource created on the success path but not released on EVERY failure/abandon path
2. Asymmetric error handling (success records/metrics/state; failure skips the same)
3. Partial batch failure (Promise.all / concurrent maps where one reject skips cleanup siblings applied)
4. State-machine / legacy edge (absent vs false, create vs update, retry vs first event)
5. Dead authz/ownership check after refactor (guard no longer on the real path)
6. Post-transform inconsistency (mapped/imported fields left null or wrong shape)
7. Cross-tenant / identity keying (cache/lock/query missing tenant or user scope)
8. Auth/outage gates and case-insensitive path allowlists that diverge from the framework matcher
9. Pagination/continuation past a hard ceiling, or OpenAPI/UI contract drift vs the handler
10. Schedule/availability window applied on authorize/playback but not on every listing/export of the same records
11. Shared-channel event listeners (storage/message/BroadcastChannel) that do not filter on key/type before invalidating state

Procedure: grep deleted/renamed symbols for remaining callers; read full changed
functions + callers/callees; compare success vs failure paths; kill false hypotheses.

Respond with STRICT JSON only — one of:
{"action":"tool","tool":{"name":"list_dir","path":"src"},"reason":"..."}
{"action":"tool","tool":{"name":"read_file","path":"src/foo.ts","offset":0,"limit":80},"reason":"..."}
{"action":"tool","tool":{"name":"grep","pattern":"functionName","path":"src","glob":"*.ts"},"reason":"..."}
{"action":"done","findings":[...],"summary":"..."}

Rules:
- Prefer 3–8 tool calls, then done. Do not loop forever.
- Paths are relative to the repo root. Never use absolute paths.
- Only report findings INTRODUCED or EXPOSED by this PR, with concrete failure scenarios.
- Prefer actionable bugs; default user-visible logic bugs to P2. Use P1 only for security/data-loss/outage with a named trigger. Omit style/docs/info unless they hide a real bug.
- findings use the same schema as a normal review (file, line, severity, category, message, confidence, …).
- When done with no issues: {"action":"done","findings":[],"summary":"…"}.
`.trim();

/** Pull likely deleted/renamed identifiers from unified diffs to seed grep. */
export function extractDeletedSymbols(files: ReviewableFile[], limit = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /^\-\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w$]*)/,
    /^\-\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w$]*)\s*=/,
    /^\-\s*(?:export\s+)?class\s+([A-Za-z_][\w$]*)/,
    /^\-\s*(?:export\s+)?(?:async\s+)?([A-Za-z_][\w$]*)\s*\([^)]*\)\s*\{/,
    /^\-\s*([A-Za-z_][\w$]*)\s*\([^)]*\)\s*\{/,
  ];
  for (const f of files) {
    if (!f.patch) continue;
    for (const line of f.patch.split('\n')) {
      if (!line.startsWith('-') || line.startsWith('---')) continue;
      for (const re of patterns) {
        const m = re.exec(line);
        if (!m) continue;
        const name = m[1];
        if (!name || name.length < 2 || seen.has(name)) continue;
        // Skip noisy short keywords.
        if (/^(if|for|while|switch|return|throw|await|import|from|type|interface)$/.test(name)) continue;
        seen.add(name);
        out.push(name);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function incomplete(summary?: string): LlmReviewResponse {
  return { findings: [], summary: summary ?? REVIEW_INCOMPLETE_SUMMARY };
}

/** Drop the rules "## Output" section so it cannot override the tool protocol. */
function stripOutputFormatInstructions(rules: string): string {
  const cut = rules.search(/\n## Output\b/);
  return cut >= 0 ? rules.slice(0, cut).trimEnd() : rules;
}

function capFindings(response: LlmReviewResponse): LlmReviewResponse {
  const maxFindings = Number(process.env.ORVEX_MAX_FINDINGS ?? 25);
  const cap = Number.isFinite(maxFindings) && maxFindings > 0 ? Math.min(Math.floor(maxFindings), 1_000) : 25;
  // Sort by severity BEFORE the cap — same policy as runLlmReview.
  const rank = (s: string): number => (s === 'P1' ? 0 : s === 'P2' ? 1 : s === 'P3' ? 2 : 3);
  const sorted = [...response.findings].sort((a, b) => rank(a.severity) - rank(b.severity));
  if (sorted.length > cap) {
    console.warn(
      `[investigate] capping ${sorted.length} findings to ${cap}; ${sorted.length - cap} lowest-severity dropped`,
    );
  }
  return { ...response, findings: sorted.slice(0, cap) };
}

function parseStep(text: string): z.infer<typeof StepSchema> | null {
  try {
    return StepSchema.parse(extractJsonLoose(text));
  } catch {
    return null;
  }
}

/**
 * Run a sandboxed investigate review: iterative tool use, then final findings.
 */
export async function runInvestigateReview(
  files: ReviewableFile[],
  opts: InvestigateOptions,
): Promise<LlmReviewResponse> {
  // Include removed files: their patches are the strongest dangling-caller signal.
  const withPatches = files.filter((f) => f.patch);
  const changed = withPatches.filter((f) => f.status !== 'removed');
  // Prefer changed files for the main prompt; fall back to removals-only PRs.
  const reviewable = changed.length > 0 ? changed : withPatches;
  if (reviewable.length === 0) {
    return {
      findings: [],
      summary: 'No reviewable text diff in this PR (binary, lockfiles, or generated paths skipped).',
    };
  }

  if (!opts.cwd || !fs.existsSync(opts.cwd)) {
    throw new Error('investigate requires a repo checkout (cwd)');
  }

  const maxSteps = opts.maxSteps ?? defaultMaxSteps();
  const maxToolChars = opts.maxToolOutputChars ?? defaultMaxToolChars();

  const redactedFiles = reviewable.map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: redactPatch(f.patch),
  }));
  const redactAll = (items?: Array<{ path: string; content: string }>) =>
    items?.map((f) => ({ ...f, content: redactSecrets(f.content) }));
  const context = opts.context
    ? {
        treePaths: opts.context.treePaths,
        related: redactAll(opts.context.related),
        dependents: redactAll(opts.context.dependents),
        changedContents: redactAll(opts.context.changedContents),
        others: redactAll(opts.context.others),
        extraFocus: opts.context.extraFocus,
      }
    : undefined;

  const system = `${INVESTIGATE_SYSTEM_EXTRA}\n\n--- Review standards (criteria only; IGNORE any Output/JSON schema below — use the tool protocol above) ---\n${stripOutputFormatInstructions(loadOrvexRules())}`;
  const baseUser = buildUserPrompt(redactedFiles, context).replace(
    'Return JSON: { "findings": [...], "summary": "..." }',
    'Do NOT return bare findings JSON yet. Use the investigate tool protocol (action tool|done) from the system prompt. Only action "done" carries findings/summary.',
  );
  // Seed from ALL patches including fully deleted files.
  const deleted = extractDeletedSymbols(withPatches);
  const transcript: string[] = [
    baseUser,
    '',
    deleted.length
      ? `Seed hypotheses — symbols removed/replaced in this diff (grep these for remaining callers):\n${deleted.map((s) => `- ${s}`).join('\n')}`
      : 'No obvious deleted symbols extracted; start from changed functions and their callers.',
    '',
    'Begin investigating. Call tools as needed, then return action "done" with findings.',
  ];

  const llmOpts = {
    apiKey: opts.apiKey,
    model: opts.model,
    baseUrl: opts.baseUrl,
    api: opts.api,
    reasoningEffort: opts.reasoningEffort,
    signal: opts.signal,
    json: true as const,
    onUsage: opts.onUsage,
    onAttempt: opts.onAttempt,
  };

  for (let step = 0; step < maxSteps; step++) {
    const forceDone = step === maxSteps - 1;
    const user = forceDone
      ? `${transcript.join('\n')}\n\nFINAL TURN — you MUST respond with {"action":"done",...} now. No more tools.`
      : transcript.join('\n');

    let text: string;
    try {
      text = await llmChat(system, user, llmOpts);
    } catch (err) {
      // Propagate step-0 failures and any later transient/rate-limit so the
      // job can requeue. Non-transient mid-loop errors must NOT look clean.
      const msg = (err as Error).message ?? '';
      if (step === 0 || isTransientLlmError(msg)) throw err;
      console.warn(`[investigate] llm error on step ${step}: ${msg.slice(0, 160)}`);
      return incomplete(REVIEW_INCOMPLETE_SUMMARY);
    }

    const parsed = parseStep(text);
    if (!parsed) {
      // Accept a bare review payload ONLY when it has real findings (model skipped the
      // tool protocol but still reviewed). Empty findings from a non-step object are
      // almost always a malformed tool call — keep looping instead of "clean" exit.
      try {
        const parsedReview = LlmReviewResponseSchema.parse(normalizeLlmResponse(extractJsonLoose(text)));
        if (parsedReview.findings.length > 0) return capFindings(parsedReview);
      } catch {
        /* fall through to retry / incomplete */
      }
      if (forceDone) return incomplete(REVIEW_INCOMPLETE_SUMMARY);
      transcript.push(
        '',
        `### Model reply (unparseable)`,
        safePromptData(clip(text, 4_000)),
        '',
        'Respond with valid JSON (action tool|done).',
      );
      continue;
    }

    if (parsed.action === 'done') {
      try {
        const rawCount = Array.isArray(parsed.findings) ? parsed.findings.length : 0;
        const parsedReview = LlmReviewResponseSchema.parse(
          normalizeLlmResponse({
            findings: parsed.findings ?? [],
            summary: parsed.summary,
          }),
        );
        // Model claimed findings that all failed schema normalization → incomplete,
        // not a clean empty pass. Intentional empty done (rawCount === 0) is fine.
        if (rawCount > 0 && parsedReview.findings.length === 0) {
          return incomplete(REVIEW_INCOMPLETE_SUMMARY);
        }
        return capFindings(parsedReview);
      } catch {
        return incomplete(REVIEW_INCOMPLETE_SUMMARY);
      }
    }

    if (forceDone) return incomplete(REVIEW_INCOMPLETE_SUMMARY);

    const result = await runInvestigateTool(opts.cwd, parsed.tool, maxToolChars);
    transcript.push(
      '',
      `### Tool ${parsed.tool.name} (${parsed.reason ?? 'investigate'})`,
      '```',
      `input: ${safePromptData(JSON.stringify(parsed.tool))}`,
      safePromptData(result),
      '```',
    );
  }

  return incomplete(REVIEW_INCOMPLETE_SUMMARY);
}
