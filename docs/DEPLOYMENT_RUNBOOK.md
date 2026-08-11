# Deployment Runbook

## Preconditions

- The intended release is committed, pushed, and the local checkout is clean.
- CI passed the policy, Redis, fresh-Linux, test, build, and compiled-export gates.
- Coverage is either enforced against a reviewed baseline or explicitly reported
  as measurement-only while no baseline exists. Do not create a baseline during
  a moving refactor; generate and review it only after the full suite is stable.
- The review queue can be drained without abandoning active paid work.
- The production database remains at `/home/orvex/orvex-data/velatrix-review.db` and the immutable production `.env` remains untouched.

Never use raw `rsync`, copy `node_modules`, edit the live source tree, or include `.env`, `.data`, database files, keys, or PEM files in a release.

## Load-Balanced Deployments

Use `/ready` only for the guarded deployment gate. It remains successful during
drain so the release script can wait for active work. An external load balancer
must instead probe `/traffic-ready`; that endpoint returns `503` as soon as the
node drains, a dependency fails, or the process is not an API role.

The current SQLite store is single-host. Do not enable multi-host API or worker
replicas until the Postgres and fleet-admission gates in the
[fleet deployment guide](./FLEET_DEPLOYMENT.md) are complete.

## Release Procedure

1. Prepare: run `scripts/deploy-safe.sh --dry-run` from the committed checkout and inspect the exact file list.
2. Validate: run the repository gates locally when practical. The guarded deployment also performs a fresh Linux install, formatting/policy checks, typecheck, tests, build, lockfile consistency, and compiled-export smoke test in its isolated stage.
3. Drain: run `scripts/deploy-safe.sh --restart`. It enables the server-side drain and waits until `/ready` reports `draining: true` and `activeJobs: 0`.
4. Activate: the script stops PM2, backs up the prior protected source release, applies the isolated staged release, and switches its Linux `node_modules` only while the service is stopped.
5. Verify: it requires `/ready` to report the generated immutable `releaseId`, then releases the drain and requires a healthy non-draining response.
6. Roll back: if activation or verification fails, the script restores the previous protected source and Linux dependencies under drain, restarts PM2, and verifies the previous `releaseId` before it exits.

For a maintenance window where reviews must remain blocked after a successful release, use `scripts/deploy-safe.sh --restart-drained`. Remove the drain only after the operator has separately confirmed readiness.

## Release Identity

The deployment script generates `release.json` in the isolated stage. Its ID is the exact Git commit SHA plus the SHA-256 of `pnpm-lock.yaml`. It contains no secret configuration. The server must expose this value at `/ready`; a ready response with a different or missing ID fails activation and triggers rollback.

## Failure Handling

- A failed dry run, stage install, typecheck, test, build, or export smoke test changes no live files.
- A service that does not become drained and idle is not stopped.
- A failed rollback leaves the drain engaged and requires operator intervention. Do not clear it to resume review intake until `/ready`, PM2, the database, and queue state have been checked.
- The deployment lock prevents two releases from staging or activating concurrently. A stale lock can be reclaimed only by the guarded script's serialized stale-lock path.

## Post-Release Evidence

Record the commit, release ID, start/end time, `--dry-run` file list, `/ready` response fields, and whether the drain was released. Do not record `.env` content, tokens, credentials, or full provider logs in the release record.
