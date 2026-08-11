/**
 * The per-pass review lenses — each pass beyond the first uses a DIFFERENT lens,
 * not a redundant re-run. Shared between the production pipeline (apps/server)
 * and the offline eval harness (apps/eval) so the eval measures the SAME
 * prompts production runs — a lens edit is automatically covered by both.
 */

export const DEEP_DIVE_FOCUS =
  'This is a SECOND, DEEPER review pass — a general pass already ran. Re-read the changed code with fresh skepticism and hunt SPECIFICALLY for the subtle, high-impact defects a first read misses:\n' +
  '- DATA INTEGRITY & MIGRATIONS: type mismatches (e.g. copying VARCHAR/UUID ids into a BIGINT column), count-based logic that can DROP or DUPLICATE rows, partial-failure / retry paths that re-run destructively, missing idempotency or version/marker guards, dropping backups before reconciling.\n' +
  '- SECURITY: auth/authz gaps, injection, IDOR, secrets, fail-OPEN defaults, signing/verification mistakes.\n' +
  '- CONCURRENCY: races, TOCTOU, non-atomic read-modify-write, lost updates.\n' +
  '- STATE-TRANSITION MATRIX: for each changed branch compare absent vs false/zero, create vs update/no-op/not-found, first event vs retry/cumulative event, and new vs restored/legacy records. Check that counters, quotas, markers, and response fields describe what actually happened.\n' +
  '- TRUST PRECEDENCE: signed/authenticated/session claims must outrank body, query, header, and User-Agent hints; request data may fill an absent claim but never override a present trusted one.\n' +
  '- LIFECYCLE OWNERSHIP: for every new lock, lease, refcount, pool, or shared tunnel, enumerate all acquire/open and release/close/destroy paths, including eviction, teardown, timeout, and overlapping-creation failure.\n' +
  '- ASYMMETRIC ERROR PATHS: when the SUCCESS path records state/metrics/usage or releases a reservation, verify EVERY failure/early-return path does the same — a coupon/lock created then abandoned on throw is a P1.\n' +
  '- PARTIAL BATCH FAILURE: Promise.all / concurrent maps where one reject skips cleanup/expiry/recording that sibling successes already applied — name the incomplete side effect.\n' +
  '- DEAD CHECK AFTER REFACTOR: an authz/ownership/precondition check that no longer sits on the real execution path (moved behind an early return, left on a dead branch, or only wrapping a no-op) — the guard looks present but never protects the sensitive action.\n' +
  '- POST-TRANSFORM CONSISTENCY: after map/import/migrate/serialize, fields that should be populated must not stay null/stale/wrong-shape relative to the source; a transform that drops descriptions or IDs is a data bug.\n' +
  '- KEYING & SCOPING: cache keys, lock names, dedup keys, or map keys that omit part of the identity (tenant/user/resource) — two different entities colliding on one key is data-leak/data-corruption territory.\n' +
  '- ENCODING BYPASS: a validator/denylist/allowlist that checks one FORM of the input but not its equivalents (hex, URL-encoded, IPv6-mapped, unicode, case) — the alternate encoding walks straight past the new check.\n' +
  '- STATED-CONTRACT VIOLATIONS: the code/comment/docstring CLAIMS a behavior (fail-open, idempotent, atomic, retries) — verify the implementation actually delivers it on every path; a claimed contract the code breaks is a bug even if each line looks fine.\n' +
  '- EDGE CASES: null/empty/boundary/malformed input, off-by-one, error paths, tests whose assertions no longer match the code they test.\n' +
  '- ENVIRONMENT: every NEW/moved file must load in its package’s module system — CJS globals (__dirname/require) in an ESM ("type": "module") package = ReferenceError at collection = P1; check the nearest package.json.\n' +
  '- ALIASING & IN-PLACE MUTATION: any code that writes to an object it did not create (deleting/overwriting fields on a caller-supplied object, a shared config/headers/request object, a cached entry) mutates state its owner still uses — serializers, redactors, and loggers are the classic offenders; require a copy-on-write. A logger that scrubs err.config.headers IN PLACE corrupts the live request = P1.\n' +
  '- CONFIG TOPOLOGY (compose/k8s/nginx/terraform/CI): treat infra files as first-class review targets. Check PARITY across sibling services/blocks (an env var, flag, or mount added to one compose/k8s service but not its siblings that need it); propagation (does the setting actually reach the runtime that reads it?); proxy/trust directives (real-ip/forwarded-for maps trusting values a direct client can spoof); widened exposure (a host/port/root grant broadened beyond localhost); and drift between compose, k8s, scripts, and docs describing the SAME deployment. A missing per-service flag that re-runs migrations on every restart = P1.\n' +
  'Report anything real the first pass would plausibly have overlooked. Do not repeat obvious findings; go deeper.\n' +
  'Before finalizing, take ONE more look at the 2-3 most complex changed areas — the subtlest bug is usually there.';

export const THIRD_ANGLE_FOCUS =
  'This is a THIRD review pass with a DIFFERENT LENS than the first two (which already covered correctness, security, data-integrity, and concurrency). Do NOT repeat those — hunt for the class of problem a bug-focused read SKIPS:\n' +
  '- PERFORMANCE: N+1 queries (especially a null/missing prefetch silently falling back to per-item queries), work inside a loop that belongs outside it, O(n^2)+ on data that grows, unbounded result sets / memory, blocking I/O on a hot path or at startup, missing pagination or an index, redundant re-computation or repeated network/DB calls.\n' +
  "- COMPLETENESS / WHAT'S MISSING: inputs never validated, error paths unhandled or swallowed, a changed function whose CALLERS or TESTS were not updated to match, a new branch with no test, missing null/empty handling, a multi-step operation with no rollback/idempotency.\n" +
  '- API / CONTRACT COMPATIBILITY: a changed signature, return shape, HTTP status, error type, DB schema, or serialized format that breaks existing callers/clients or stored data. Include OpenAPI/UI advertising an endpoint or field the handler does not implement (or the reverse), and pagination links that continue past a hard ceiling.\n' +
  '- FALLBACK / LEGACY PARITY: normal and fallback branches must use the same real enum values, error classes, and output shape. Legacy protected/encrypted data that looks corrupted must fail closed, not pass through as plaintext.\n' +
  '- DESIGN (only when it will cause real bugs or heavy future cost): a bandaid special-case that should be a deeper fix, duplicated logic that will drift out of sync, an abstraction that invites misuse.\n' +
  'Every finding must name a concrete failure or measurable cost. Skip anything the correctness/security passes would already catch.\n' +
  'Before finalizing, take ONE more look at the 2-3 most complex changed areas through this lens — the subtlest miss is usually there.';

/** Removed behaviour and caller audit, reusable inside a broader review pass. */
export const REMOVED_BEHAVIOR_FOCUS =
  'As part of this same deep-dive pass, also audit the changed behaviour and its callers. Do not repeat findings from the general pass; hunt these things specifically:\n' +
  '- REMOVED / WEAKENED BEHAVIOUR: for every line this diff DELETES or replaces, name the invariant it enforced (a guard, validation, error path, cleanup, ordering constraint, permission check), then find where the new code re-establishes it. A dropped guard, a narrowed validation, a deleted error branch, or a cleanup that now only runs on the happy path is a finding. State what input now gets through that previously did not.\n' +
  '- CALLER & CONTRACT AUDIT: trace every changed function to its CALLERS. Does any call site break on a new precondition, a changed return shape or type, a new thrown error, a changed null/empty result, or a different ordering/timing? Check the tests that exercise it too — a test that still passes because it asserts the OLD contract is a finding.\n' +
  '- STATE ACROSS ATTEMPTS: for any retry, resume, reconnect, or replay path, enumerate what state SURVIVES from the previous attempt and what must be reset. State carried into a retry that should have been cleared is a bug even when each line looks correct.\n' +
  '- LEGACY DATA PREDATING THE FIX: a new guard, validator, index, or required column only protects rows/config created AFTER it ships. Ask what happens to records that already exist — stored paths that never passed the new validation, rows without the new dedup key, in-flight jobs with a NULL value the new code assumes is set. If pre-existing data bypasses or breaks the new rule, that is a finding; name the migration or backfill that is missing.\n' +
  '- ROLLING DEPLOY COEXISTENCE: during rollout, OLD workers/replicas run against the NEW schema and new rows (and vice versa) at the same time. A new required field old code never writes, a lease/marker old workers never renew, or a reaper that reclaims work still owned by an old-format worker are all findings. Assume both versions run concurrently for minutes to hours.\n' +
  '- ADJACENT-FLOW STATE: when a change touches one auth/security/lifecycle flow, check its SIBLING flows for state that must be created, completed, or reset there too — a lockout counter not cleared by account recovery, a step-up flow one entry point enforces and another skips, a replay key derived from unverified instead of verified state. The bug is in the flow the diff did NOT touch.\n' +
  '- NEW-TYPE DOWNSTREAM CONSUMERS: a new enum value, transaction/record type, or event kind must be handled by EVERY existing consumer of that stream — totals/reports, renderers, reconcilers, exporters, filters. Locate the consumers and name each one that silently ignores or miscounts the new type.\n' +
  '- OVER-STRICT NEW VALIDATION: a new validator must still accept every LEGITIMATE existing configuration and input. If a valid legacy setup, a documented feature, or a value the system itself generates now gets rejected, that is a functional regression, not safety. Never recommend loosening a control that was deliberately tightened for security — flag only genuine functional breakage.\n' +
  'GROUNDING: cite only files and lines that actually appear in the diff or the source context you were given. If the sibling flow, consumer, or legacy-data path you suspect is NOT visible in that context, do not invent a file:line or assert the bug exists — these checks earn findings only when the evidence is on screen.\n' +
  'Report only concrete breakages with file:line and the input or sequence that triggers them.';

/**
 * One high-tier Flash pass combines the deep correctness audit with the
 * removed-behaviour/caller audit. Keeping this as one shared constant prevents
 * production and evaluation from drifting into different review contracts.
 */
export const HIGH_TIER_FLASH_FOCUS = `${DEEP_DIVE_FOCUS}\n\n${REMOVED_BEHAVIOR_FOCUS}`;

/**
 * RISK HUNT — additive, best-effort Flash pass for high-risk diffs only.
 *
 * Does NOT replace existing lenses. Targets the miss classes from head-to-head
 * benchmarks (auth/outage gates, Promise.all partial cleanup, username/tenant
 * keying, pagination continuations, OpenAPI/contract drift, case-insensitive
 * route matching). Every finding still needs a concrete failure scenario and
 * still goes through the normal verifier — this is recall, not a severity
 * promotion pass.
 */
export const RISK_HUNT_FOCUS =
  'This is an EXTRA RISK-HUNT pass on a high-risk diff. Earlier passes already ran — do NOT repeat their findings. Hunt ONLY these historically missed P1/P2 classes, and only with a concrete failure scenario:\n' +
  '- AUTH / OUTAGE GATES: error or outage state that bypasses auth redirects, MFA, or admin gates; unsigned request fields overriding signed/session claims; case-insensitive route/path matching the framework does but the allowlist does not.\n' +
  '- PARTIAL ASYNC FAILURE: Promise.all / Promise.allSettled / batch loops where one failure skips cleanup, expiry, release, or recording that sibling successes already performed.\n' +
  '- IDENTITY KEYING: username/tenant/panel caches or indexes keyed without tenant (or vice versa); positive caches never rebuilt after delete; locked tenants still counted as matches.\n' +
  '- PAGINATION / CONTINUATION: offset+limit continuations that emit links past the hard ceiling, use unstable offsets on mutable data, or truncate without disclosing it.\n' +
  '- CONTRACT / OPENAPI DRIFT: UI or docs advertising an endpoint/field/type the OpenAPI/schema/handler does not implement (or the reverse); rolling-deploy breakage from new required JWT/claim fields old tokens lack.\n' +
  '- LIFECYCLE / STORAGE: delete-before-commit reclaim, drop-database-before-restore without a durable guarantee, artifact cleanup that deletes live files still referenced outside the ledger.\n' +
  '- SCHEDULE / AVAILABILITY DIVERGENCE: an availability/schedule window applied on authorize/playback but not on every listing/export (M3U, XMLTV, catalog) that advertises the same records — or the reverse.\n' +
  '- EVENT FANOUT: storage/message/BroadcastChannel listeners that invalidate or re-render on every event without filtering event.key/type, so unrelated writers trigger wasted work or races.\n' +
  'RULES: report only P1/P2 with file:line and a named trigger (input/state → wrong outcome). If you cannot construct that scenario from the supplied diff/context, stay silent — do not invent style, docs, or speculative nits. Prefer one sharp bug over three weak ones.';
