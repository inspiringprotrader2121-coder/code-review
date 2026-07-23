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
  '- API / CONTRACT COMPATIBILITY: a changed signature, return shape, HTTP status, error type, DB schema, or serialized format that breaks existing callers/clients or stored data.\n' +
  '- FALLBACK / LEGACY PARITY: normal and fallback branches must use the same real enum values, error classes, and output shape. Legacy protected/encrypted data that looks corrupted must fail closed, not pass through as plaintext.\n' +
  '- DESIGN (only when it will cause real bugs or heavy future cost): a bandaid special-case that should be a deeper fix, duplicated logic that will drift out of sync, an abstraction that invites misuse.\n' +
  'Every finding must name a concrete failure or measurable cost. Skip anything the correctness/security passes would already catch.\n' +
  'Before finalizing, take ONE more look at the 2-3 most complex changed areas through this lens — the subtlest miss is usually there.';
