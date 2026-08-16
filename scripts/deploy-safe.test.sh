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
    ecosystem.config.cjs \
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
grep -Fxq '  LICENSE' scripts/deploy-safe.sh || {
  echo "deploy release manifest omits the README-linked license" >&2
  exit 1
}

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
if [[ $(grep -c -- "--exclude 'dist/'" scripts/deploy-safe.sh) -ne 2 ]]; then
  echo "deploy must exclude local/old dist while preserving staged Linux dist for apply and rollback" >&2
  exit 1
fi
if [[ $(grep -c -- 'rsync -a.*--checksum' scripts/deploy-safe.sh) -ne 5 ]]; then
  echo "deploy must checksum release bytes across upload, stage, backup, apply, and rollback" >&2
  exit 1
fi
node <<'NODE'
const { readFileSync } = require('node:fs');
const source = readFileSync('scripts/deploy-safe.sh', 'utf8');
function remoteBlock(name) {
  const match = source.match(new RegExp(`<<'${name}'\\n([\\s\\S]*?)\\n${name}`));
  if (!match) throw new Error(`missing ${name} block`);
  return match[1];
}
if (!remoteBlock('REMOTE_STAGE').includes("--exclude 'dist/'")) {
  throw new Error('stage initialization can retain stale live dist');
}
for (const name of ['REMOTE_BACKUP', 'REMOTE_APPLY', 'REMOTE_ROLLBACK']) {
  if (remoteBlock(name).includes("--exclude 'dist/'")) {
    throw new Error(`${name} drops the Linux-built or rollback dist tree`);
  }
}
if (!source.includes('[[ -f apps/server/dist/index.js ]]')) {
  throw new Error('staged release does not require the production entrypoint');
}
for (const name of ['REMOTE_APPLY', 'REMOTE_ROLLBACK']) {
  const block = remoteBlock(name);
  if (!block.includes('move_dependency_trees') || !block.includes("-name node_modules")) {
    throw new Error(`${name} does not move every server-built workspace dependency tree`);
  }
}
NODE

extract_remote_block() {
  node - "$1" <<'NODE'
const { readFileSync } = require('node:fs');
const marker = process.argv[2];
const source = readFileSync('scripts/deploy-safe.sh', 'utf8');
const match = source.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}`));
if (!match) process.exit(1);
process.stdout.write(match[1]);
NODE
}

node <<'NODE'
const { readFileSync } = require('node:fs');
const source = readFileSync('scripts/deploy-safe.sh', 'utf8');
if (source.includes('is-enabled orvex-stack.service')) {
  throw new Error('an enabled but inactive systemd unit must not select the live process manager');
}
if (!source.includes('detect_process_manager') || !source.includes('PROCESS_MANAGER=$(detect_process_manager)')) {
  throw new Error('deploy must identify the active process manager before draining');
}
if (!source.includes('refusing split-brain deploy')) {
  throw new Error('deploy must refuse a simultaneously active Docker and PM2 fleet');
}
NODE

MANAGER_FIXTURE=$(mktemp -d)
trap 'rm -rf -- "$MANAGER_FIXTURE"' EXIT
mkdir -p "$MANAGER_FIXTURE/bin" "$MANAGER_FIXTURE/home/.pm2"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "$1" == "-n" ]]; then shift; fi' \
  'exec "$@"' >"$MANAGER_FIXTURE/bin/sudo"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "$1" == "start" ]]; then [[ -n "${DEPLOY_TEST_STATE:-}" ]] && : >"$DEPLOY_TEST_STATE/systemctl-started"; exit 0; fi' \
  'if [[ "$1" == "is-active" ]]; then' \
  '  if [[ -n "${DEPLOY_TEST_STATE:-}" && -e "$DEPLOY_TEST_STATE/systemctl-started" ]]; then' \
  '    count_file="$DEPLOY_TEST_STATE/systemctl-active-count"' \
  '    count=0; [[ -f "$count_file" ]] && count=$(cat "$count_file")' \
  '    count=$((count + 1)); printf "%s" "$count" >"$count_file"' \
  '    ((count >= 2)) && exit 0; exit 3' \
  '  fi' \
  '  [[ "${DEPLOY_TEST_DOCKER_ACTIVE:-0}" == 1 ]] && exit 0; exit 3' \
  'fi' \
  'exit 0' >"$MANAGER_FIXTURE/bin/systemctl"
chmod +x "$MANAGER_FIXTURE/bin/"*

if [[ "$(extract_remote_block REMOTE_DETECT_PROCESS_MANAGER | env \
  PATH="$MANAGER_FIXTURE/bin:$PATH" HOME="$MANAGER_FIXTURE/home" DEPLOY_TEST_DOCKER_ACTIVE=1 bash)" != "docker" ]]; then
  echo "active Docker stack was not selected as the process manager" >&2
  exit 1
fi
if extract_remote_block REMOTE_DETECT_PROCESS_MANAGER | env \
  PATH="$MANAGER_FIXTURE/bin:$PATH" HOME="$MANAGER_FIXTURE/home" bash >/dev/null 2>&1; then
  echo "deploy guessed a process manager when neither runtime was active" >&2
  exit 1
fi
mkdir -p "$MANAGER_FIXTURE/state"
extract_remote_block REMOTE_RESTART | env \
  PATH="$MANAGER_FIXTURE/bin:$PATH" DEPLOY_TEST_STATE="$MANAGER_FIXTURE/state" \
  ORVEX_STACK_START_ATTEMPTS=2 ORVEX_STACK_START_SLEEP_S=0 \
  bash -s -- /srv/orvex docker
if [[ "$(cat "$MANAGER_FIXTURE/state/systemctl-active-count")" != "2" ]]; then
  echo "Docker restart did not wait for the systemd unit to become active" >&2
  exit 1
fi
rm -rf -- "$MANAGER_FIXTURE"
trap - EXIT

TRANSFER_FIXTURE=$(mktemp -d)
trap 'rm -rf -- "$TRANSFER_FIXTURE"' EXIT
TRANSFER_LIVE="$TRANSFER_FIXTURE/live"
TRANSFER_STAGE="$TRANSFER_FIXTURE/stage"
TRANSFER_BACKUP="$TRANSFER_FIXTURE/backup"
mkdir -p \
  "$TRANSFER_LIVE/apps/server/dist" \
  "$TRANSFER_LIVE/apps/server/node_modules" \
  "$TRANSFER_LIVE/node_modules" \
  "$TRANSFER_LIVE/.data" \
  "$TRANSFER_STAGE/apps/server/dist" \
  "$TRANSFER_STAGE/apps/server/node_modules" \
  "$TRANSFER_STAGE/node_modules" \
  "$TRANSFER_BACKUP/apps/server/dist"
printf 'old-dist\n' >"$TRANSFER_LIVE/apps/server/dist/index.js"
printf 'old-source\n' >"$TRANSFER_LIVE/old-source.txt"
printf 'old-root-deps\n' >"$TRANSFER_LIVE/node_modules/root.txt"
printf 'old-workspace-deps\n' >"$TRANSFER_LIVE/apps/server/node_modules/server.txt"
printf 'immutable-env\n' >"$TRANSFER_LIVE/.env"
printf 'durable-data\n' >"$TRANSFER_LIVE/.data/runtime.txt"
printf 'old-dist\n' >"$TRANSFER_BACKUP/apps/server/dist/index.js"
printf 'old-source\n' >"$TRANSFER_BACKUP/old-source.txt"
printf 'new-dist\n' >"$TRANSFER_STAGE/apps/server/dist/index.js"
printf 'new-source\n' >"$TRANSFER_STAGE/new-source.txt"
printf 'new-root-deps\n' >"$TRANSFER_STAGE/node_modules/root.txt"
printf 'new-workspace-deps\n' >"$TRANSFER_STAGE/apps/server/node_modules/server.txt"

extract_remote_block REMOTE_APPLY \
  | bash -s -- "$TRANSFER_LIVE" "$TRANSFER_STAGE" "$TRANSFER_BACKUP"
grep -Fxq 'new-dist' "$TRANSFER_LIVE/apps/server/dist/index.js"
grep -Fxq 'new-root-deps' "$TRANSFER_LIVE/node_modules/root.txt"
grep -Fxq 'new-workspace-deps' "$TRANSFER_LIVE/apps/server/node_modules/server.txt"
grep -Fxq 'old-root-deps' "$TRANSFER_BACKUP/node_modules/root.txt"
grep -Fxq 'old-workspace-deps' "$TRANSFER_BACKUP/apps/server/node_modules/server.txt"
grep -Fxq 'immutable-env' "$TRANSFER_LIVE/.env"
grep -Fxq 'durable-data' "$TRANSFER_LIVE/.data/runtime.txt"
[[ ! -e "$TRANSFER_LIVE/old-source.txt" ]]

extract_remote_block REMOTE_ROLLBACK \
  | bash -s -- "$TRANSFER_LIVE" "$TRANSFER_BACKUP"
grep -Fxq 'old-dist' "$TRANSFER_LIVE/apps/server/dist/index.js"
grep -Fxq 'old-root-deps' "$TRANSFER_LIVE/node_modules/root.txt"
grep -Fxq 'old-workspace-deps' "$TRANSFER_LIVE/apps/server/node_modules/server.txt"
grep -Fxq 'new-root-deps' "$TRANSFER_LIVE/node_modules.failed/root.txt"
grep -Fxq 'immutable-env' "$TRANSFER_LIVE/.env"
grep -Fxq 'durable-data' "$TRANSFER_LIVE/.data/runtime.txt"
[[ ! -e "$TRANSFER_LIVE/new-source.txt" ]]
rm -rf -- "$TRANSFER_FIXTURE"
trap - EXIT

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
const names = (config.apps ?? []).map((app) => app.name);
for (const required of ['velatrix-api', 'velatrix-scheduler', 'velatrix-worker-01']) {
  if (!names.includes(required)) {
    throw new Error(`production profile is missing PM2 app ${required}`);
  }
}
if (names.filter((name) => name.startsWith('velatrix-worker-')).length !== 13) {
  throw new Error('production profile must define 13 worker apps');
}
const workerArgs = config.apps?.find((app) => app.name === 'velatrix-worker-01')?.args ?? '';
const schedulerArgs = config.apps?.find((app) => app.name === 'velatrix-scheduler')?.args ?? '';
for (const [variable, expected] of Object.entries({
  ORVEX_MAX_CONCURRENT_REVIEWS: 10000,
  ORVEX_CODEX_APIKEY_CONCURRENCY: 10000,
  ORVEX_PROVIDER_CONCURRENCY_LUNA: 10000,
  ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK: 10000,
  ORVEX_PROVIDER_CONCURRENCY_MINIMAX: 10000,
  ORVEX_FLEET_PROVIDER_CONCURRENCY_LUNA: 10000,
  ORVEX_FLEET_PROVIDER_CONCURRENCY_DEEPSEEK: 10000,
  ORVEX_FLEET_PROVIDER_CONCURRENCY_MINIMAX: 10000,
  ORVEX_FLEET_TENANT_CONCURRENCY: 8,
  ORVEX_PROVIDER_LEASE_WAIT_MS: 600000,
  ORVEX_VERIFY_CONCURRENCY: 10000,
  ORVEX_MAX_SANDBOXES: 10000,
})) {
  if (!workerArgs.includes(`${variable}=${expected}`)) {
    throw new Error(`production worker profile does not pin ${variable}=${expected}`);
  }
}
if (!schedulerArgs.includes('ORVEX_WORKER_ID=scheduler-01')) {
  throw new Error('production scheduler profile does not pin ORVEX_WORKER_ID');
}
if (!workerArgs.includes('ORVEX_FLEET_CAPACITY_EPOCH=review-scale-v4')) {
  throw new Error('production profile does not pin the review-scale-v4 capacity epoch');
}
if (!workerArgs.includes('ORVEX_UNLIMITED_GITHUB_OWNERS=inspiringprotrader2121-coder')) {
  throw new Error('production profile does not pin the operator GitHub owner');
}
if (!workerArgs.includes('ORVEX_UNLIMITED_ACCOUNT_EMAILS=inspiringprotrader2121@gmail.com')) {
  throw new Error('production profile does not pin the operator account email');
}
if (
  !workerArgs.includes(
    'ORVEX_UNLIMITED_TENANT_SLUGS=org-inspiringprotrader2121-coder,inspiringprotrader2121-coder',
  )
) {
  throw new Error('production profile does not pin the operator tenant slugs');
}
if (workerArgs.indexOf('. ./.env') > workerArgs.indexOf('ORVEX_MAX_CONCURRENT_REVIEWS=10000')) {
  throw new Error('immutable .env would override the code-owned production profile');
}
if (!String(require('fs').readFileSync('ecosystem.config.cjs', 'utf8')).includes('deploy-safe')) {
  throw new Error('ecosystem multi-app profile must document the deploy-safe follow-up');
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
  '  if [[ "$SCRIPT" == *"pm2 stop"* ]]; then : >"$DEPLOY_TEST_STATE/stopped"; fi' \
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
