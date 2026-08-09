#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# The real checkout can be intentionally dirty while this test is running. Run
# the restart flow from a disposable committed fixture so production never needs
# a dirty-tree bypass. The fixture's ssh binary is a local recorder, not ssh.
if [[ "${DEPLOY_SAFE_TEST_FIXTURE:-0}" != "1" ]]; then
  FIXTURE=$(mktemp -d)
  trap 'rm -rf "$FIXTURE"' EXIT
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git archive HEAD | tar -x -C "$FIXTURE"
  else
    # Staged production releases intentionally contain no .git directory.
    # Recreate the same protected-path boundary for the disposable fixture.
    rsync -a \
      --include '.env.example' \
      --exclude '.git/' --exclude '.DS_Store' --exclude '.env' --exclude '.env.*' \
      --exclude '.data/' --exclude 'node_modules/' --exclude 'node_modules.failed/' --exclude 'dist/' --exclude 'build/' \
      --exclude '*.tsbuildinfo' --exclude '*.pem' --exclude '*.key' --exclude '*.db' --exclude '*.db-*' \
      --exclude '*.sqlite' --exclude '*.sqlite3' \
      "$ROOT/" "$FIXTURE/"
  fi
  mkdir -p "$FIXTURE/scripts"
  cp \
    scripts/deploy-safe.sh \
    scripts/deploy-safe.test.sh \
    scripts/provision-internal-sandbox.sh \
    scripts/provision-internal-sandbox.test.sh \
    scripts/build-internal-sandbox-image.sh \
    scripts/build-internal-sandbox-image.test.sh \
    "$FIXTURE/scripts/"
  cp \
    tsconfig.json \
    .node-version \
    .prettierignore \
    .prettierrc.json \
    "$FIXTURE/"
  mkdir -p "$FIXTURE/sandbox/runtime"
  cp sandbox/runtime/Dockerfile "$FIXTURE/sandbox/runtime/"
  cp -R infra "$FIXTURE/"
  git -C "$FIXTURE" init -q
  git -C "$FIXTURE" config user.name 'deploy-safe test'
  git -C "$FIXTURE" config user.email 'deploy-safe-test@invalid'
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" commit -qm 'deploy-safe test fixture'
  DEPLOY_SAFE_TEST_FIXTURE=1 bash "$FIXTURE/scripts/deploy-safe.test.sh"
  exit $?
fi

scripts/deploy-safe.sh --validate-only
scripts/deploy-safe.sh --validate-only .env.example

if ! TEST_RELEASE_COMMIT=$(git rev-parse --verify HEAD 2>/dev/null); then
  TEST_RELEASE_COMMIT=$(node -e '
    const value = require("./release.json");
    if (!/^[0-9a-f]{40}$/.test(value.commit ?? "")) process.exit(1);
    process.stdout.write(value.commit);
  ')
fi
TEST_RELEASE_LOCKFILE_SHA256=$(shasum -a 256 pnpm-lock.yaml | awk '{print $1}')
TEST_RELEASE_ID="${TEST_RELEASE_COMMIT}.${TEST_RELEASE_LOCKFILE_SHA256}"
export DEPLOY_READY_ATTEMPTS=2
export DEPLOY_READY_SLEEP_S=0
export DEPLOY_IDLE_ATTEMPTS=2
export DEPLOY_IDLE_SLEEP_S=0
export REMOTE='stage@example.test:/srv/orvex/'
export DEPLOY_DRAIN_PATH=/tmp/stage-deploy-drain

if [[ $(grep -c -- "--include '.env.example'" scripts/deploy-safe.sh) -ne 5 ]]; then
  echo "deploy must allow .env.example through upload, stage, backup, apply, and rollback" >&2
  exit 1
fi
if [[ $(grep -c -- "--exclude '.DS_Store'" scripts/deploy-safe.sh) -ne 5 ]]; then
  echo "deploy must exclude macOS metadata from upload, stage, backup, apply, and rollback" >&2
  exit 1
fi
if [[ $(grep -c -- "--exclude '\*.tsbuildinfo'" scripts/deploy-safe.sh) -ne 5 ]]; then
  echo "deploy must exclude generated TypeScript build metadata from every release path" >&2
  exit 1
fi
if [[ $(grep -c -- "--exclude 'node_modules.failed/'" scripts/deploy-safe.sh) -ne 5 ]]; then
  echo "deploy must exclude rollback-quarantined dependencies from every release path" >&2
  exit 1
fi
grep -Fq 'bash -s -- "$REMOTE_DIR" "$STAGE_DIR" "${SOURCES[@]}"' scripts/deploy-safe.sh || {
  echo "deploy does not pass selected sources to isolated stage preparation" >&2
  exit 1
}
for staged_gate in format:check check:runtime check:dependencies 'dedupe --check' check:architecture check:docs typecheck test build check:built-exports; do
  if ! grep -Fq "corepack pnpm@11.7.0 --pm-on-fail=ignore $staged_gate" scripts/deploy-safe.sh; then
    echo "deploy does not run staged $staged_gate gate" >&2
    exit 1
  fi
done
grep -Fq 'rm -rf -- "$stage/$source"' scripts/deploy-safe.sh || {
  echo "deploy stage does not remove stale copies of selected local sources" >&2
  exit 1
}
grep -Fq 'install_backup_schedule' scripts/deploy-safe.sh || {
  echo "deploy does not install the database backup schedule" >&2
  exit 1
}
if rg -q 'DEPLOY_TEST_MODE|stage@example\.test' scripts/deploy-safe.sh; then
  echo "deploy script retains a test-mode or host-name deployment bypass" >&2
  exit 1
fi

node <<'NODE'
const config = require('./ecosystem.config.cjs');
const args = config.apps?.find((app) => app.name === 'velatrix-review')?.args ?? '';
for (const variable of [
  'ORVEX_MAX_CONCURRENT_REVIEWS',
  'ORVEX_CODEX_APIKEY_CONCURRENCY',
  'ORVEX_PROVIDER_CONCURRENCY_LUNA',
  'ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK',
  'ORVEX_PROVIDER_CONCURRENCY_MINIMAX',
]) {
  if (!args.includes(`${variable}=8`)) {
    throw new Error(`production profile does not pin ${variable}=8`);
  }
}
if (args.indexOf('. ./.env') > args.indexOf('ORVEX_MAX_CONCURRENT_REVIEWS=8')) {
  throw new Error('immutable .env would override the code-owned production profile');
}
NODE

# Stale-lock inspection and takeover must be serialized. Without this guard two
# reclaimers can both delete/recreate the same lock and both enter deployment.
grep -q 'flock -n' scripts/deploy-safe.sh || {
  echo "deploy lock takeover is not guarded by flock" >&2
  exit 1
}

assert_rejected() {
  local source=$1
  if scripts/deploy-safe.sh --validate-only "$source" >/dev/null 2>&1; then
    echo "deploy validation accepted protected source: $source" >&2
    exit 1
  fi
}

assert_rejected .env
assert_rejected node_modules
assert_rejected node_modules/.pnpm
assert_rejected apps/server/node_modules
assert_rejected node_modules.failed

FAKE_BIN=$(mktemp -d)
STATE=$(mktemp -d)
trap 'rm -rf "$FAKE_BIN" "$STATE"' EXIT

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "$*" == *deploy-stage* ]]; then : >"$DEPLOY_TEST_STATE/stage-rsync"; else : >"$DEPLOY_TEST_STATE/live-rsync"; fi' \
  'printf "%s\n" "$*" >>"$DEPLOY_TEST_STATE/rsync-args"' >"$FAKE_BIN/rsync"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\n" "$*" >>"$DEPLOY_TEST_STATE/ssh-args"' \
  'if [[ "$*" == *curl* ]]; then' \
  '  release_id=${DEPLOY_TEST_RELEASE_ID:-missing}' \
  '  if [[ ! -e "$DEPLOY_TEST_STATE/restarted" && "${DEPLOY_TEST_PREVIOUS_RELEASE_MISSING:-0}" == 1 ]]; then release_id=missing; fi' \
  '  if [[ -e "$DEPLOY_TEST_STATE/restarted" && "${DEPLOY_TEST_POST_READY_RELEASE_MISMATCH:-0}" == 1 ]]; then release_id=wrong-release; fi' \
  '  if [[ -e "$DEPLOY_TEST_STATE/restarted" && "${DEPLOY_TEST_POST_READY_FAIL:-0}" == 1 ]]; then exit 22; fi' \
  '  if [[ -e "$DEPLOY_TEST_STATE/restarted" && "${DEPLOY_TEST_POST_READY_MALFORMED:-0}" == 1 ]]; then printf "{\"activeJobs\":0}\n"; exit 0; fi' \
  '  if [[ "${DEPLOY_TEST_OLD_READY:-0}" == 1 && ! -e "$DEPLOY_TEST_STATE/restarted" ]]; then printf "{\"ok\":true}\n"; exit 0; fi' \
  '  if [[ "${DEPLOY_TEST_READY_MODE:-idle}" == busy ]]; then printf "{\"ok\":true,\"activeJobs\":1,\"draining\":true,\"releaseId\":\"%s\"}\n" "$release_id"; elif [[ -e "$DEPLOY_TEST_STATE/restarted" && -e "$DEPLOY_TEST_STATE/drain-cleared" && "${DEPLOY_TEST_POST_READY_BUSY:-0}" == 1 ]]; then printf "{\"ok\":true,\"activeJobs\":1,\"draining\":false,\"releaseId\":\"%s\"}\n" "$release_id"; elif [[ -e "$DEPLOY_TEST_STATE/drain-cleared" ]]; then printf "{\"ok\":true,\"activeJobs\":0,\"draining\":false,\"releaseId\":\"%s\"}\n" "$release_id"; else printf "{\"ok\":true,\"activeJobs\":0,\"draining\":true,\"releaseId\":\"%s\"}\n" "$release_id"; fi' \
  'elif [[ "$*" == *"pm2 stop"* ]]; then' \
  '  : >"$DEPLOY_TEST_STATE/stopped"' \
  'elif [[ "$*" == *"pm2 restart"* ]]; then' \
  '  : >"$DEPLOY_TEST_STATE/restarted"' \
  'elif [[ "$*" == *"bash -s"* ]]; then' \
  '  SCRIPT=$(cat)' \
  '  if [[ "$*" == *.lock* ]]; then' \
  '    if [[ "$SCRIPT" == *rmdir* ]]; then rm -f "$DEPLOY_TEST_STATE/lock" "$DEPLOY_TEST_STATE/lock-stale"; elif [[ -e "$DEPLOY_TEST_STATE/lock" && ! -e "$DEPLOY_TEST_STATE/lock-stale" ]]; then exit 75; else : >"$DEPLOY_TEST_STATE/lock"; rm -f "$DEPLOY_TEST_STATE/lock-stale"; fi' \
  '  fi' \
  '  if [[ "$SCRIPT" == *"pnpm@11.7.0"* && "${DEPLOY_TEST_STAGE_FAIL:-0}" == 1 ]]; then exit 23; fi' \
  '  if [[ "$SCRIPT" == *"release.json"* && "$SCRIPT" == *"lockfileSha256"* ]]; then printf "%s\n" "$*" >"$DEPLOY_TEST_STATE/release-metadata-args"; fi' \
  '  if [[ "$SCRIPT" == *"startOrRestart"* || "$SCRIPT" == *"pm2 restart"* || "$SCRIPT" == *"pm2 start /usr/bin/bash"* ]]; then : >"$DEPLOY_TEST_STATE/restarted"; fi' \
  '  if [[ "$SCRIPT" == *"touch --"* ]]; then : >"$DEPLOY_TEST_STATE/draining"; fi' \
  '  if [[ "$SCRIPT" == *"rm -f -- \"\$1\""* ]]; then : >"$DEPLOY_TEST_STATE/drain-cleared"; fi' \
  '  : >"$DEPLOY_TEST_STATE/installed"' \
  'fi' >"$FAKE_BIN/ssh"
chmod +x "$FAKE_BIN/rsync" "$FAKE_BIN/ssh"
export DEPLOY_TEST_RELEASE_ID="$TEST_RELEASE_ID"

if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" DEPLOY_TEST_READY_MODE=busy \
  DEPLOY_IDLE_ATTEMPTS=2 DEPLOY_IDLE_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy restart succeeded even though activeJobs never reached zero" >&2
  exit 1
fi
if [[ -e "$STATE/live-rsync" || -e "$STATE/stopped" ]]; then
  echo "deploy changed the server before it became idle" >&2
  exit 1
fi

rm -f "$STATE"/*
: >"$STATE/lock"
if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy proceeded while another deployment held the lock" >&2
  exit 1
fi
if [[ -e "$STATE/stage-rsync" || -e "$STATE/stopped" ]]; then
  echo "locked deployment touched stage or live process" >&2
  exit 1
fi
rm -f "$STATE/lock"

# Stale lock (crashed deploy) must be RECLAIMED, not block deploys forever.
: >"$STATE/lock"
: >"$STATE/lock-stale"
if ! PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy refused to reclaim a stale deployment lock" >&2
  exit 1
fi
if [[ -e "$STATE/lock-stale" ]]; then
  echo "stale lock marker survived — reclaim path not taken" >&2
  exit 1
fi
if [[ ! -f "$STATE/release-metadata-args" ]] \
  || ! grep -Fq "$TEST_RELEASE_COMMIT" "$STATE/release-metadata-args" \
  || ! grep -Fq "$TEST_RELEASE_LOCKFILE_SHA256" "$STATE/release-metadata-args"; then
  echo "deploy did not generate staged release metadata from the local commit and lockfile" >&2
  exit 1
fi
rm -f "$STATE"/*

if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" DEPLOY_TEST_STAGE_FAIL=1 \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy accepted a failed staged install" >&2
  exit 1
fi
if [[ -e "$STATE/stopped" || -e "$STATE/restarted" ]]; then
  echo "staged install failure touched the live process" >&2
  exit 1
fi

rm -f "$STATE"/*
PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" \
  REMOTE='stage@example.test:/srv/orvex/' DEPLOY_DRAIN_PATH=/tmp/stage-deploy-drain \
  DEPLOY_TEST_POST_READY_BUSY=1 \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null
for marker in stopped stage-rsync installed restarted; do
  if [[ ! -e "$STATE/$marker" ]]; then
    echo "guarded deployment missed step: $marker" >&2
    exit 1
  fi
done
if ! grep -q 'stage@example.test' "$STATE/ssh-args" || grep -q '87.106.103.185' "$STATE/ssh-args"; then
  echo "deploy did not use the host derived from REMOTE" >&2
  exit 1
fi

rm -f "$STATE"/*
PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart-drained scripts/deploy-safe.sh >/dev/null
for marker in draining restarted; do
  if [[ ! -e "$STATE/$marker" ]]; then
    echo "drained deployment missed step: $marker" >&2
    exit 1
  fi
done
if [[ -e "$STATE/drain-cleared" ]]; then
  echo "drained deployment released the review drain" >&2
  exit 1
fi

rm -f "$STATE"/*
if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" DEPLOY_TEST_POST_READY_FAIL=1 \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy accepted failed post-restart readiness" >&2
  exit 1
fi
if [[ ! -e "$STATE/draining" || -e "$STATE/drain-cleared" ]]; then
  echo "failed deployment did not preserve the drain" >&2
  exit 1
fi

rm -f "$STATE"/*
if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" DEPLOY_TEST_POST_READY_MALFORMED=1 \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy accepted malformed post-restart readiness" >&2
  exit 1
fi

rm -f "$STATE"/*
if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" DEPLOY_TEST_POST_READY_RELEASE_MISMATCH=1 \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy accepted a ready process running a different release" >&2
  exit 1
fi
if [[ ! -e "$STATE/draining" || -e "$STATE/drain-cleared" ]]; then
  echo "release mismatch did not preserve the drain" >&2
  exit 1
fi

rm -f "$STATE"/*
if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" DEPLOY_TEST_PREVIOUS_RELEASE_MISSING=1 \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy accepted an unavailable prior release identity" >&2
  exit 1
fi
if [[ -e "$STATE/stopped" || -e "$STATE/live-rsync" || -e "$STATE/restarted" ]]; then
  echo "deploy touched the live release without a verified rollback identity" >&2
  exit 1
fi
if [[ ! -e "$STATE/draining" || -e "$STATE/drain-cleared" ]]; then
  echo "missing prior identity did not preserve the drain" >&2
  exit 1
fi

# This local fake transport is the test fixture: it records invocations but
# cannot open a network connection. A dirty source must be rejected before it.
rm -f "$STATE"/*
DIRTY_FIXTURE="$ROOT/.deploy-safe-dirty-test-$$"
trap 'rm -rf "$FAKE_BIN" "$STATE" "$DIRTY_FIXTURE"' EXIT
touch "$DIRTY_FIXTURE"
if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy accepted a dirty worktree" >&2
  exit 1
fi
if [[ -e "$STATE/ssh-args" || -e "$STATE/stage-rsync" || -e "$STATE/live-rsync" ]]; then
  echo "dirty-tree rejection attempted the test transport" >&2
  exit 1
fi

echo "deploy-safe tests passed"
