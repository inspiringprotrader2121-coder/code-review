/**
 * High-risk diff gate, and the named hypotheses that gate selects.
 *
 * `isHighRiskDiff` decides WHETHER extra hunting is worth a call;
 * `detectRiskSignals` decides WHAT that call should hunt for. Both trigger only
 * on classes that historically hid high-severity misses (auth, billing,
 * cleanup/lifecycle, pagination, contracts). False positives stay controlled
 * because the hunt is best-effort and still runs through the same verifier as
 * every other pass.
 */

export interface RiskDiffFile {
  filename: string;
  patch?: string | null;
  status?: string;
}

const RISK_PATH_RE =
  /(?:^|\/)(?:auth|oauth|session|middleware|security|tenant|billing|payment|stripe|refund|invoice|coupon|subscription|quota|gdpr|privacy|export|delete|cleanup|reclaim|lease|lock|cache|pool|tunnel|webhook|openapi|swagger|deploy|dockerfile|compose|nginx|k8s|kubernetes)(?:[./]|$)|(?:route|controller|resolver|provisioner|archive|epg|username.?index|iptv)/i;

const RISK_DIFF_RE =
  /\b(?:auth(?:z|n)?|permission|role|admin|session|csrf|jwt|token|password|tenant|panel.?slug|billing|stripe|refund|invoice|coupon|idempotenc|quota|overage|gdpr|anonymiz|delete|drop\b|cleanup|reclaim|lease|lock|refcount|promise\.all|partial(?:ly)?\s+fail|pagination|continuation|offset|cursor|openapi|swagger|allowed.?stb|case.?insensit|host\s*=\s*['"]%['"]|MYSQL_ROOT_HOST|AbortController|outage|merge.?conflict)\b/i;

/** True when the PR touches paths/content that historically hide P1/P2 misses. */
export function isHighRiskDiff(files: readonly RiskDiffFile[]): boolean {
  let pathHits = 0;
  let diffHits = 0;
  for (const file of files) {
    if (!file.filename) continue;
    // Deletion hunks still carry risk keywords (auth/cleanup/lease); skipping
    // status===removed made delete-only PRs invisible to the risk hunt.
    if (RISK_PATH_RE.test(file.filename)) pathHits += 1;
    const patch = file.patch ?? '';
    if (!patch) continue;
    // Count distinct keyword hits so one file with Promise.all + pagination
    // still qualifies; a lone weak token on a non-risk path does not.
    const matches = patch.match(new RegExp(RISK_DIFF_RE.source, 'gi'));
    if (matches) diffHits += matches.length;
  }
  // Require either a clear risk path, or two independent risk signals in the
  // hunk text so ordinary UI copy cannot trigger the extra pass alone.
  return pathHits >= 1 || diffHits >= 2;
}

/**
 * One named, checkable hypothesis about this diff.
 *
 * The generic hunting pass asks a model to keep many miss classes in mind at
 * once, which dilutes every one of them. A signal is instead a single claim
 * scoped to the files that triggered it, so a probe can spend its whole budget
 * proving or killing exactly that claim — the same reason Greptile v5's
 * narrowly-scoped agents beat one broad reviewer on the classes below.
 */
export interface RiskSignal {
  id: string;
  label: string;
  /** Changed files whose hunks matched, most relevant first. */
  files: string[];
  /** Hypothesis handed to the probe, written as an instruction to disprove. */
  probe: string;
}

interface SignalRule {
  id: string;
  label: string;
  /** Matched against hunk text. */
  test: RegExp;
  /** Optional second term that must ALSO appear, to keep weak tokens honest. */
  qualifier?: RegExp;
  probe: string;
}

/**
 * Ordered by how often the class produced a confirmed high-severity miss in the
 * PRs #231–250 benchmark, because the probe budget is small and the top of this
 * list is what it should spend on first.
 */
const SIGNAL_RULES: readonly SignalRule[] = [
  {
    id: 'degraded-auth',
    label: 'degraded state reaches a privileged view',
    test: /\b(?:outage|degraded|offline|unavailable|isLoading|loading|catch|error|fallback|retry)\b/i,
    qualifier: /\b(?:session|auth(?:z|n)?|permission|role|admin|impersonat|redirect|guard|route)\b/i,
    probe:
      'A session/permission/role lookup can FAIL (network error, 5xx, timeout) rather than return '
      + 'a definite allow or deny. Trace what the code renders or routes to in that failure state. '
      + 'If any privileged view, admin index, impersonation path, or protected route is reachable '
      + 'while the lookup is errored, unknown, or still loading, that is an auth bypass (P1). '
      + 'Check the deny path and the error path SEPARATELY — they are frequently not the same branch.',
  },
  {
    id: 'partial-batch',
    label: 'partial batch failure skips post-loop work',
    test: /Promise\s*\.\s*(?:all|allSettled)|for\s+await|\.map\s*\(\s*async/i,
    probe:
      'A concurrent batch runs here. Determine what happens when ONE element rejects after siblings '
      + 'have already committed their writes. Follow the code AFTER the batch: any cleanup, expiry, '
      + 'revocation, notification, counter update, or state transition that is skipped by the throw '
      + 'is skipped for records that DID change, and nothing retries them. Name the records left '
      + 'half-transitioned. `allSettled` without inspecting rejected entries is the same defect.',
  },
  {
    id: 'retry-lost-write',
    label: 'retry short-circuit drops a dependent write',
    test: /\bidempotenc|already\s+(?:exists|processed|completed|redeemed|applied)|ON\s+CONFLICT|\bupsert|\bretr(?:y|ies|ied)\b|\b(?:completed|existing|duplicate)\b/i,
    // The loose "already done" markers only matter next to a write they can
    // skip, so a bare `existing` in unrelated code cannot claim the probe.
    qualifier: /\b(?:increment|count|usage|quota|ledger|balance|credit|redeem|charge|insert|update|create|write)\b/i,
    probe:
      'This path can run twice. Find the marker it checks to decide "already done" (an existing row, '
      + 'a completed count, an idempotency key) and find every write that happens AFTER that marker '
      + 'is created. If a first attempt can die between writing the marker and finishing those '
      + 'dependent writes — a counter increment, usage row, quota decrement, ledger entry — the retry '
      + 'short-circuits and that write is lost permanently. Rate P1 when the lost write enforces a '
      + 'limit, quota, entitlement, or money.',
  },
  {
    id: 'pagination-ceiling',
    label: 'enumeration truncates silently',
    test: /\b(?:offset|cursor|continuation|nextPage|hasMore|page_?size|LIMIT\s+\d|take\s*:|skip\s*:)\b/i,
    probe:
      'An enumeration is paginated or capped here. Find the hard ceiling — a maximum offset, a row '
      + 'cap, a maximum page count — and compare it against how the next-page link or cursor is '
      + 'computed. If the cursor can point past the ceiling, or the last page is emitted without a '
      + 'truncation marker, the caller receives a PARTIAL result it cannot distinguish from a '
      + 'complete one. Say what the caller then does with the missing rows: a compliance export, a '
      + 'deletion, a reconciliation, or a security decision makes this P1.',
  },
  {
    id: 'tenant-keying',
    label: 'shared key collides across tenants',
    test: /\b(?:cache|redis|lock|index|registry|map|bucket|namespace)\b/i,
    qualifier: /\b(?:tenant|panel|slug|username|account|org(?:anisation|anization)?|customer|reseller)\b/i,
    probe:
      'A shared keyspace (cache, Redis index, lock, in-memory map) is written here. Reconstruct the '
      + 'EXACT key and check whether it includes the tenant/panel/account scope. If two tenants can '
      + 'produce the same key, one silently overwrites or reads the other: state which caller reads '
      + 'the key and what wrong record it gets. Check the delete/invalidate path uses the same key '
      + 'shape as the write path — a mismatch leaves stale entries that outlive the record.',
  },
  {
    id: 'contract-drift',
    label: 'declared contract diverges from the handler',
    // `route` and `schema` matched almost any backend diff and crowded out
    // sharper hypotheses, so the trigger now needs a contract vocabulary and
    // the qualifier needs an actual operation.
    test: /\b(?:openapi|swagger|endpoint)\b|\bapi\s+docs?\b|\bpaths?\s*:/i,
    qualifier: /\b(?:GET|POST|PUT|PATCH|DELETE|operationId|requestBody|responses?|components)\b/,
    probe:
      'A contract surface (OpenAPI/Swagger document, API docs page, typed client, route table) is '
      + 'touched. Compare EVERY method+path it declares against the handlers that actually exist, in '
      + 'both directions: a documented endpoint with no handler 404s for integrators who trust the '
      + 'docs, and a live endpoint missing from the contract is unversioned surface. Also compare '
      + 'request/response field names and required flags, not just the paths.',
  },
  {
    id: 'lifecycle-cleanup',
    label: 'resource outlives its owner',
    test: /\b(?:cleanup|expire|expiry|reclaim|revoke|release|dispose|ttl|lease|tempor(?:ary|ies)|unlink|rmdir)\b/i,
    probe:
      'A resource with a lifetime is created, extended, or released here. Enumerate every exit from '
      + 'the owning scope — success, each thrown error, early return, timeout, cancellation, process '
      + 'exit — and check the release runs on ALL of them. Then check the reverse: whether anything '
      + 'reclaims the resource if the owner dies without running its cleanup at all. Leaked leases, '
      + 'locks, temp files, and unexpired entitlements accumulate into outages and billing errors.',
  },
  {
    id: 'schedule-window',
    label: 'one query applies a window others ignore',
    // Bare `active` and `between` fired on ordinary code; the window only
    // matters where some read path applies it. Also match availability helpers
    // — PR #247 only added `buildAvailabilityWhere` to authorizeLiveStream with
    // no "schedule" token in the hunk, so the probe never fired and Greptile's
    // "playback vs listings diverge" finding went unmatched.
    test: /\b(?:schedule[ds]?|window|start_?(?:at|time)|end_?(?:at|time)|expires_?at|valid_?(?:from|until)|availability|isAvailable|withinSchedule|buildAvailability)\b/i,
    qualifier: /\b(?:select|query|where|filter|list(?:ing)?s?|fetch|rows?|find|playlist|m3u|xmltv|catalog|authorize|playback|stream)\b/i,
    probe:
      'A time or state window gates something here. Find EVERY other query, listing, or export that '
      + 'reads the same records — playback vs listings, authorize vs M3U/XMLTV/catalog, API vs UI, '
      + 'feed vs detail — and check they apply the identical window. When one path filters and '
      + 'another does not, users see an entry that fails when opened, or reach content that should '
      + 'be gated. Name both paths and the record that diverges. A helper applied on ONLY the '
      + 'authorize/playback path is the classic form of this defect.',
  },
  {
    id: 'event-fanout',
    label: 'broad event listener reacts to unrelated updates',
    // Greptile catch on PR #233: a `storage` listener invalidated consent on
    // EVERY cross-tab write (language, theme, …), not just the consent key.
    // No trailing \b after the quoted type — the next char is usually `,`.
    test: /(?:addEventListener\s*\(\s*['"`](?:storage|message)['"`]|\bonstorage\b|\bStorageEvent\b|\bBroadcastChannel\b)/i,
    probe:
      'An event listener is registered on a SHARED channel (window storage, message, BroadcastChannel). '
      + 'Check whether it filters on event.key / event.type / channel name before doing work. If it '
      + 'reacts to EVERY event on that channel — invalidating a cache, re-parsing JSON, setState, '
      + 'refetch — then unrelated writers (language, theme, other features) trigger unnecessary work '
      + 'and can race the feature\'s own state. Name the unrelated key/event that would fire it and '
      + 'the wasted work that follows. Rate P2 when the work is a re-parse or re-render; P1 if it '
      + 'can clear or overwrite authoritative state for another feature.',
  },
  {
    id: 'fresh-host-bootstrap',
    label: 'bootstrap assumes state that only exists after a prior run',
    // `install`, `deploy`, and `migrate` appear in ordinary application code;
    // the infrastructure nouns are what mark real bootstrap logic.
    test: /\b(?:docker|compose|volume|systemd|nginx|bootstrap|provision)\b/i,
    probe:
      'This is deployment/bootstrap code. Replay it against a FRESH host where no prior run has '
      + 'happened: no named volumes, no existing containers, no seeded database, no previous config. '
      + 'Any precondition check that hard-fails on absence — rather than creating the resource or '
      + 'treating absence as first-run — blocks every new install while passing on the maintainer\'s '
      + 'own machine. Distinguish "must already exist" from "must exist after this step".',
  },
];

/** Cap on files listed per signal, to keep the probe prompt tight. */
const MAX_SIGNAL_FILES = 4;

/**
 * Word-boundary patterns cannot see inside an identifier: `\boutage\b` does not
 * match `OutageScreen`, and `\bcount\b` does not match `incrementUsedCount`,
 * which is where most of these signals actually live. Append a split copy of
 * the text rather than replacing it, so patterns that rely on the original
 * spelling (`Promise.all`, `ON CONFLICT`) keep matching.
 */
function withSplitIdentifiers(text: string): string {
  return `${text}\n${text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')}`;
}

/**
 * Named hypotheses worth a dedicated probe, strongest first.
 *
 * A rule fires only on ADDED/CONTEXT hunk text of changed files, so a signal
 * always points at code this PR is responsible for.
 */
export function detectRiskSignals(files: readonly RiskDiffFile[]): RiskSignal[] {
  const hits = new Map<string, string[]>();
  let changedCount = 0;
  for (const file of files) {
    if (!file.filename || file.status === 'removed') continue;
    if (file.patch) changedCount += 1;
    const patch = file.patch ?? '';
    if (!patch) continue;
    // Deletions describe the OLD behaviour; a hypothesis about what this PR
    // now does must be grounded in the lines that survive it.
    const added = patch
      .split('\n')
      .filter((line) => !line.startsWith('-') && !line.startsWith('+++') && !line.startsWith('@@'))
      .join('\n');
    if (!added.trim()) continue;
    const searchable = withSplitIdentifiers(added);
    for (const rule of SIGNAL_RULES) {
      if (!rule.test.test(searchable)) continue;
      if (rule.qualifier && !rule.qualifier.test(searchable)) continue;
      const list = hits.get(rule.id) ?? [];
      list.push(file.filename);
      hits.set(rule.id, list);
    }
  }
  return SIGNAL_RULES.filter((rule) => hits.has(rule.id))
    .map((rule) => {
      const matched = hits.get(rule.id) ?? [];
      return {
        id: rule.id,
        label: rule.label,
        files: matched.slice(0, MAX_SIGNAL_FILES),
        probe: rule.probe,
        // A rule that fired on EVERY changed file matched a keyword the diff
        // happens to use everywhere, not a place worth probing. Observed on PR
        // #240, where two such rules outranked the pagination hypothesis that
        // pointed straight at the actual defect.
        generic: changedCount >= 3 && matched.length >= changedCount,
      };
    })
    // Selective hypotheses first, then the ones matching most files. `sort` is
    // stable, so remaining ties keep the benchmark-derived order above.
    .sort((a, b) => Number(a.generic) - Number(b.generic) || b.files.length - a.files.length)
    .map(({ generic: _generic, ...signal }) => signal);
}

/** Render one signal as a focused instruction for a single probe pass. */
export function riskProbeFocus(signal: RiskSignal): string {
  return [
    `## Single-hypothesis probe: ${signal.label}`,
    '',
    'Spend this entire pass on ONE hypothesis. Do not review the diff broadly, do not report',
    'style or breadth nits, and do not repeat findings another pass would obviously make.',
    '',
    `Files that triggered it: ${signal.files.join(', ')}`,
    '',
    signal.probe,
    '',
    'Report a finding ONLY with a concrete failure path: the input or state that triggers it, the',
    'exact line where the wrong behaviour happens, and the observable consequence. If the code',
    'already handles this correctly, return no findings and say in the summary which specific',
    'guard disproves the hypothesis — a clean kill is a successful probe, not a failed one.',
  ].join('\n');
}
