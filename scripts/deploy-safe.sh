#!/usr/bin/env bash
set -euo pipefail

REMOTE=${REMOTE:-orvex@87.106.103.185:/home/orvex/code-review/}
SSH_KEY=${SSH_KEY:-/Users/johnboy/Documents/Documents - John’s MacBook Air/00_Documents_Hub/Keys_Secrets/Websites/87.106/orvex/server_access_ed25519}

EXCLUDES=(
  --include '.env.example'
  --exclude '.git/'
  --exclude '.DS_Store'
  --exclude '.env'
  --exclude '.env.*'
  --exclude '.data/'
  --exclude 'node_modules/'
  --exclude 'dist/'
  --exclude 'build/'
  --exclude '*.pem'
  --exclude '*.key'
  --exclude '*.db'
  --exclude '*.db-*'
  --exclude '*.sqlite'
  --exclude '*.sqlite3'
)

DEFAULT_SOURCES=(
  apps
  packages
  rules
  examples
  docs
  scripts/deploy-safe.sh
  scripts/deploy-safe.test.sh
  scripts/provision-internal-sandbox.sh
  scripts/provision-internal-sandbox.test.sh
  scripts/backup-db.mjs
  scripts/restore-db-drill.mjs
  scripts/orvex-backup.cron
  README.md
  PLAN.md
  ROADMAP.md
  AGENTS.md
  CLAUDE.md
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.base.json
  ecosystem.config.cjs
  .env.example
  .rsync-filter
)

MODE=${1:-}
DRY_RUN=()
case "$MODE" in
  --dry-run)
    DRY_RUN=(--dry-run --itemize-changes)
    shift
    ;;
  --restart|--validate-only)
    shift
    ;;
  --*)
    echo "[deploy] unknown option: $MODE" >&2
    exit 2
    ;;
esac

if (($# > 0)); then
  SOURCES=("$@")
else
  SOURCES=("${DEFAULT_SOURCES[@]}")
fi

for source in "${SOURCES[@]}"; do
  if [[ "$source" = /* || "$source" == *'..'* || ! -e "$source" ]]; then
    echo "[deploy] refusing invalid source: $source" >&2
    exit 2
  fi
  case "$source" in
    .env.example)
      ;;
    .env|*/.env|.env.*|*/.env.*|*.pem|*.key|*.db|*.db-*|*.sqlite|*.sqlite3|node_modules|node_modules/*|*/node_modules|*/node_modules/*|dist|dist/*|*/dist|*/dist/*|.data|.data/*|*/.data|*/.data/*)
      echo "[deploy] refusing protected source: $source" >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" == "--validate-only" ]]; then
  exit 0
fi

# Release metadata is generated, never copied from the worktree. It lets the
# running process prove that it is serving the exact source + dependency graph
# that passed the staged Linux checks, without exposing any runtime settings.
if ! RELEASE_COMMIT=$(git rev-parse --verify HEAD 2>/dev/null); then
  echo "[deploy] unable to resolve the local Git commit for release metadata" >&2
  exit 2
fi
if ! RELEASE_LOCKFILE_SHA256=$(shasum -a 256 pnpm-lock.yaml | awk '{print $1}'); then
  echo "[deploy] unable to hash pnpm-lock.yaml for release metadata" >&2
  exit 2
fi
if [[ ! "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ || ! "$RELEASE_LOCKFILE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "[deploy] refusing malformed release metadata identity" >&2
  exit 2
fi
RELEASE_ID="${RELEASE_COMMIT}.${RELEASE_LOCKFILE_SHA256}"

base_cmd=(rsync -az --relative --delay-updates "${EXCLUDES[@]}" \
  -e "ssh -i \"$SSH_KEY\" -o BatchMode=yes -o ConnectTimeout=15")
cmd=("${base_cmd[@]}")
if ((${#DRY_RUN[@]} > 0)); then
  cmd+=("${DRY_RUN[@]}")
fi
cmd+=("${SOURCES[@]}" "$REMOTE")

if [[ "$MODE" == "--restart" ]]; then
  if [[ "$REMOTE" != *:* ]]; then
    echo "[deploy] REMOTE must be in user@host:/absolute/path form" >&2
    exit 2
  fi
  REMOTE_HOST=${REMOTE%%:*}
  REMOTE_DIR=${REMOTE#*:}
  REMOTE_DIR=${REMOTE_DIR%/}
  if [[ -z "$REMOTE_HOST" || "$REMOTE_DIR" != /* ]]; then
    echo "[deploy] refusing malformed REMOTE: $REMOTE" >&2
    exit 2
  fi
  if [[ -n "$(git status --porcelain --untracked-files=normal 2>/dev/null)" ]]; then
    echo "[deploy] refusing restart from a dirty worktree; commit the exact release first" >&2
    exit 2
  fi

  # Upload only bytes tracked by the exact release commit. A normal rsync from
  # the checkout can include ignored caches or local-only files inside selected
  # source directories even when `git status` is clean.
  LOCAL_RELEASE=$(mktemp -d)
  if ! git archive "$RELEASE_COMMIT" -- "${SOURCES[@]}" | tar -x -C "$LOCAL_RELEASE"; then
    rm -rf -- "$LOCAL_RELEASE"
    echo "[deploy] could not materialize the committed release sources" >&2
    exit 2
  fi

  SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST")
  STAGE_DIR="${REMOTE_DIR}.deploy-stage"
  BACKUP_DIR="${REMOTE_DIR}.deploy-backup"
  if [[ -z "${DEPLOY_DRAIN_PATH:-}" && "$REMOTE_HOST" != "orvex@87.106.103.185" ]]; then
    echo "[deploy] set DEPLOY_DRAIN_PATH when deploying to a non-production host" >&2
    exit 2
  fi
  DRAIN_PATH=${DEPLOY_DRAIN_PATH:-/home/orvex/orvex-data/deploy-drain}
  stage_cmd=("${base_cmd[@]}")
  for source in "${SOURCES[@]}"; do
    if [[ -d "$source" ]]; then
      stage_cmd+=(--delete-delay)
      break
    fi
  done
  stage_cmd+=("${SOURCES[@]}" "${REMOTE_HOST}:${STAGE_DIR}/")
  LOCK_DIR=${DEPLOY_LOCK_DIR:-${DRAIN_PATH}.lock}
  drain_set=0
  lock_held=0

  clear_drain() {
    if ((drain_set)); then
      if ! "${SSH[@]}" bash -s -- "$DRAIN_PATH" <<'REMOTE_CLEAR'
set -euo pipefail
rm -f -- "$1"
REMOTE_CLEAR
      then
        echo "[deploy] CRITICAL: could not remove drain marker $DRAIN_PATH" >&2
        return 1
      fi
      drain_set=0
    fi
  }
  set_drain() {
    "${SSH[@]}" bash -s -- "$DRAIN_PATH" <<'REMOTE_DRAIN'
set -euo pipefail
mkdir -p "$(dirname -- "$1")"
touch -- "$1"
REMOTE_DRAIN
    drain_set=1
  }
  release_deploy_lock() {
    if ((lock_held)); then
      if ! "${SSH[@]}" bash -s -- "$LOCK_DIR" <<'REMOTE_UNLOCK'
set -euo pipefail
rm -f -- "$1/meta"
rmdir -- "$1"
REMOTE_UNLOCK
      then
        echo "[deploy] CRITICAL: could not release deployment lock $LOCK_DIR" >&2
        return 1
      fi
      lock_held=0
    fi
  }
  cleanup() {
    local status=$?
    rm -rf -- "$LOCAL_RELEASE"
    if ((drain_set)); then
      if ((status == 0)); then
        if ! clear_drain; then status=20; fi
      else
        echo "[deploy] deployment failed; preserving the production drain" >&2
      fi
    fi
    if ((lock_held)) && ! release_deploy_lock; then status=20; fi
    exit "$status"
  }
  trap cleanup EXIT

  # Deploy lock with STALE-LOCK RECLAMATION: the lock dir carries holder/PID/epoch
  # metadata. A deploy that crashes (laptop died, SSH dropped) never releases its
  # lock — without reclamation every future deploy would be blocked forever, so a
  # lock older than DEPLOY_LOCK_STALE_S (default 6h; a real deploy takes minutes)
  # is reclaimed. `flock` serializes inspection + takeover so two reclaimers can
  # never remove one another's newly acquired lock.
  LOCK_STALE_S=${DEPLOY_LOCK_STALE_S:-21600}
  LOCK_HOLDER="${USER:-unknown}@$(hostname -s 2>/dev/null || hostname)"
  if ! "${SSH[@]}" bash -s -- "$LOCK_DIR" "$LOCK_HOLDER" "$$" "$LOCK_STALE_S" <<'REMOTE_LOCK'
set -euo pipefail
lock=$1
holder=$2
pid=$3
stale_s=$4
guard="${lock}.guard"
command -v flock >/dev/null 2>&1 || { echo "[deploy] flock is required for atomic deploy locking" >&2; exit 4; }
exec 9>"$guard"
flock -n 9 || { echo "[deploy] another process is inspecting the deployment lock" >&2; exit 3; }
write_meta() {
  printf 'holder=%s\npid=%s\nepoch=%s\n' "$holder" "$pid" "$(date +%s)" >"$lock/meta"
}
if mkdir -- "$lock" 2>/dev/null; then
  write_meta
  exit 0
fi
# Lock exists — decide stale vs live. Epoch comes from the embedded metadata;
# a legacy metadata-less lock falls back to the dir's mtime.
meta_epoch=''
if [[ -f "$lock/meta" ]]; then
  meta_epoch=$(sed -n 's/^epoch=//p' -- "$lock/meta" | tail -1)
fi
if [[ ! "$meta_epoch" =~ ^[0-9]+$ ]]; then
  meta_epoch=$(stat -c %Y -- "$lock" 2>/dev/null || echo 0)
fi
now=$(date +%s)
age=$((now - meta_epoch))
if ((meta_epoch > 0 && age > stale_s)); then
  echo "[deploy] lock is STALE (age ${age}s > ${stale_s}s) — reclaiming: $(tr '\n' ' ' <"$lock/meta" 2>/dev/null || echo 'no metadata')" >&2
  rm -rf -- "$lock"
  if mkdir -- "$lock" 2>/dev/null; then
    write_meta
    exit 0
  fi
  echo "[deploy] lost the stale-lock reclaim race to a concurrent deploy" >&2
  exit 3
fi
echo "[deploy] lock held (age ${age}s): $(tr '\n' ' ' <"$lock/meta" 2>/dev/null || echo 'no metadata')" >&2
exit 1
REMOTE_LOCK
  then
    echo "[deploy] another deployment is already active on $REMOTE_HOST" >&2
    exit 2
  fi
  lock_held=1

  echo "[deploy] preparing isolated Linux release at $STAGE_DIR"
  "${SSH[@]}" bash -s -- "$REMOTE_DIR" "$STAGE_DIR" "${SOURCES[@]}" <<'REMOTE_STAGE'
set -euo pipefail
live=$1
stage=$2
shift 2
rm -rf "$stage"
mkdir -p "$stage"
rsync -a --delete \
  --include '.env.example' \
  --exclude '.git/' --exclude '.DS_Store' --exclude '.env' --exclude '.env.*' \
  --exclude '.data/' --exclude 'node_modules/' --exclude 'dist/' \
  --exclude 'build/' --exclude '*.pem' --exclude '*.key' \
  --exclude '*.db' --exclude '*.db-*' --exclude '*.sqlite' --exclude '*.sqlite3' \
  "$live/" "$stage/"
# Remove each selected source from the isolated stage before uploading it. This
# makes local deletions authoritative without touching protected live state.
for source in "$@"; do
  rm -rf -- "$stage/$source"
done
REMOTE_STAGE
  (cd "$LOCAL_RELEASE" && "${stage_cmd[@]}")

  # release.json is a generated, non-secret deployment artifact. It must be in
  # the stage before tests and activation; the ordinary apply/backup/rollback
  # rsync paths preserve it while retaining every existing protected-path rule.
  "${SSH[@]}" bash -s -- "$STAGE_DIR" "$RELEASE_COMMIT" "$RELEASE_LOCKFILE_SHA256" "$RELEASE_ID" <<'REMOTE_RELEASE_METADATA'
set -euo pipefail
stage=$1
commit=$2
lockfile_sha256=$3
release_id=$4
printf '{\n  "schemaVersion": 1,\n  "releaseId": "%s",\n  "commit": "%s",\n  "lockfileSha256": "%s"\n}\n' \
  "$release_id" "$commit" "$lockfile_sha256" >"$stage/release.json"
chmod 0644 "$stage/release.json"
REMOTE_RELEASE_METADATA

  echo "[deploy] installing and checking the staged Linux release"
  "${SSH[@]}" bash -s -- "$STAGE_DIR" <<'REMOTE_CHECK'
set -euo pipefail
cd "$1"
CI=1 corepack pnpm@11.7.0 --pm-on-fail=ignore install --frozen-lockfile
CI=1 corepack pnpm@11.7.0 --pm-on-fail=ignore typecheck
CI=1 corepack pnpm@11.7.0 --pm-on-fail=ignore test
REMOTE_CHECK

  parse_ready() {
      local expected_release_id=${2:-}
      node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      if (!value || value.ok !== true) process.exit(2);
      const expectedReleaseId = process.argv[1];
      const releaseId = typeof value.releaseId === "string" && value.releaseId ? value.releaseId : "missing";
      if (expectedReleaseId && releaseId !== expectedReleaseId) process.exit(3);
      const active = Number.isInteger(value.activeJobs) && value.activeJobs >= 0 ? value.activeJobs : "missing";
      process.stdout.write(`${active}\t${value.draining === true ? "true" : value.draining === false ? "false" : "missing"}\t${releaseId}`);
    ' "$expected_release_id" <<<"$1"
  }

  ready_json() {
    local attempts=${1:-30}
    local sleep_s=${2:-2}
    local require_not_draining=${3:-0}
    local require_idle=${4:-1}
    local expected_release_id=${5:-}
    local ready details active draining release_id
    for i in $(seq 1 "$attempts"); do
      if ready=$("${SSH[@]}" 'curl -fsS -m 5 http://127.0.0.1:8788/ready') \
        && details=$(parse_ready "$ready" "$expected_release_id"); then
        IFS=$'\t' read -r active draining release_id <<<"$details"
        if [[ "$active" != "missing" && ("$require_idle" != "1" || "$active" == "0") && ("$require_not_draining" != "1" || "$draining" == "false") ]]; then
          printf '%s\n' "$ready"
          return 0
        fi
        echo "[deploy] readiness: activeJobs=$active draining=$draining releaseId=$release_id ($i/$attempts)"
      else
        if [[ -n "$expected_release_id" ]]; then
          echo "[deploy] readiness probe failed or releaseId did not match expected staged release ($i/$attempts)"
        else
          echo "[deploy] readiness probe failed ($i/$attempts)"
        fi
      fi
      if ((i < attempts)); then sleep "$sleep_s"; fi
    done
    return 1
  }

  echo "[deploy] enabling server-side drain before the idle check"
  set_drain

  IDLE=0
  PREVIOUS_RELEASE_ID=''
  IDLE_ATTEMPTS=${DEPLOY_IDLE_ATTEMPTS:-90}
  IDLE_SLEEP_S=${DEPLOY_IDLE_SLEEP_S:-10}
  BOOTSTRAP=${DEPLOY_BOOTSTRAP_DRAIN:-0}
  echo "[deploy] waiting for the drained worker to become idle"
  for i in $(seq 1 "$IDLE_ATTEMPTS"); do
    if READY=$("${SSH[@]}" 'curl -fsS -m 5 http://127.0.0.1:8788/ready') \
      && DETAILS=$(parse_ready "$READY"); then
      IFS=$'\t' read -r ACTIVE DRAINING CURRENT_RELEASE_ID <<<"$DETAILS"
      if [[ "$ACTIVE" == "0" && "$DRAINING" == "true" ]]; then
        if [[ "$CURRENT_RELEASE_ID" != "missing" && "$CURRENT_RELEASE_ID" != "unknown" ]]; then
          PREVIOUS_RELEASE_ID=$CURRENT_RELEASE_ID
        fi
        IDLE=1
        break
      fi
      if [[ ("$ACTIVE" == "0" || "$ACTIVE" == "missing") && "$DRAINING" == "missing" && "$BOOTSTRAP" == "1" ]]; then
        echo "[deploy] old server lacks drain support; using one-time graceful bootstrap"
        IDLE=1
        break
      fi
      echo "[deploy] activeJobs=$ACTIVE draining=$DRAINING ($i/$IDLE_ATTEMPTS)"
    else
      echo "[deploy] readiness probe failed ($i/$IDLE_ATTEMPTS)"
    fi
    if ((i < IDLE_ATTEMPTS)); then sleep "$IDLE_SLEEP_S"; fi
  done
  if [[ "$IDLE" != "1" ]]; then
    echo "[deploy] aborting before touching live files: service did not become drained and idle" >&2
    exit 3
  fi
  if [[ -z "$PREVIOUS_RELEASE_ID" ]]; then
    echo "[deploy] aborting before touching live files: prior release identity is unavailable" >&2
    exit 3
  fi

  echo "[deploy] gracefully stopping the drained app"
  if ! "${SSH[@]}" 'pm2 stop velatrix-review >/dev/null'; then
    echo "[deploy] PM2 stop failed; attempting to bring the unchanged app back" >&2
    if ! "${SSH[@]}" 'pm2 restart velatrix-review --update-env >/dev/null'; then
      echo "[deploy] CRITICAL: could not restart the unchanged app" >&2
      exit 20
    fi
    if ! ready_json "${DEPLOY_READY_ATTEMPTS:-30}" "${DEPLOY_READY_SLEEP_S:-2}" 0 1 >/dev/null; then
      echo "[deploy] CRITICAL: unchanged app did not become ready" >&2
      exit 20
    fi
    exit 5
  fi

  echo "[deploy] backing up current live source"
  if ! "${SSH[@]}" bash -s -- "$REMOTE_DIR" "$BACKUP_DIR" <<'REMOTE_BACKUP'
set -euo pipefail
live=$1
backup=$2
rm -rf "$backup"
mkdir -p "$backup"
rsync -a --delete \
  --include '.env.example' \
  --exclude '.git/' --exclude '.DS_Store' --exclude '.env' --exclude '.env.*' \
  --exclude '.data/' --exclude 'node_modules/' --exclude 'dist/' --exclude 'build/' \
  --exclude '*.pem' --exclude '*.key' --exclude '*.db' --exclude '*.db-*' \
  --exclude '*.sqlite' --exclude '*.sqlite3' "$live/" "$backup/"
REMOTE_BACKUP
  then
    echo "[deploy] backup failed; restarting the unchanged live app" >&2
    if ! "${SSH[@]}" 'pm2 restart velatrix-review --update-env >/dev/null'; then
      echo "[deploy] CRITICAL: could not restart the unchanged live app" >&2
      exit 20
    fi
    if ! ready_json "${DEPLOY_READY_ATTEMPTS:-30}" "${DEPLOY_READY_SLEEP_S:-2}" 0 1 >/dev/null; then
      echo "[deploy] CRITICAL: unchanged app did not become ready" >&2
      exit 20
    fi
    exit 5
  fi

  apply_release() {
    "${SSH[@]}" bash -s -- "$REMOTE_DIR" "$STAGE_DIR" "$BACKUP_DIR" <<'REMOTE_APPLY'
set -euo pipefail
live=$1
stage=$2
backup=$3
rsync -a --delete-delay \
  --include '.env.example' \
  --exclude '.git/' --exclude '.DS_Store' --exclude '.env' --exclude '.env.*' \
  --exclude '.data/' --exclude 'node_modules/' --exclude 'dist/' --exclude 'build/' \
  --exclude '*.pem' --exclude '*.key' --exclude '*.db' --exclude '*.db-*' \
  --exclude '*.sqlite' --exclude '*.sqlite3' "$stage/" "$live/"
mv "$live/node_modules" "$backup/node_modules"
mv "$stage/node_modules" "$live/node_modules"
REMOTE_APPLY
  }

  restart_release() {
    "${SSH[@]}" bash -s -- "$REMOTE_DIR" <<'REMOTE_RESTART'
set -euo pipefail
live=$1
if [[ -f "$live/ecosystem.config.cjs" ]]; then
  pm2 startOrRestart "$live/ecosystem.config.cjs" --only velatrix-review --update-env >/dev/null
else
  # The first release may predate the ecosystem file. Recreate the legacy
  # process explicitly so a failed ecosystem rollout cannot leave PM2 using
  # stale args or the .env port during rollback.
  pm2 delete velatrix-review >/dev/null 2>&1 || true
  pm2 start /usr/bin/bash --name velatrix-review --interpreter none -- \
    -lc 'cd /home/orvex/code-review && set -a && . ./.env && set +a && NODE_ENV=production ORVEX_REQUIRE_DURABLE_STORAGE=1 PORT=8788 HOST=0.0.0.0 ORVEX_MAX_CONCURRENT_REVIEWS=8 ORVEX_CODEX_APIKEY_CONCURRENCY=8 ORVEX_PROVIDER_CONCURRENCY_LUNA=8 ORVEX_PROVIDER_CONCURRENCY_DEEPSEEK=8 ORVEX_PROVIDER_CONCURRENCY_MINIMAX=8 pnpm start' >/dev/null
fi
REMOTE_RESTART
  }

  install_backup_schedule() {
    "${SSH[@]}" bash -s -- "$REMOTE_DIR" <<'REMOTE_BACKUP_SCHEDULE'
set -euo pipefail
live=$1
schedule=$live/scripts/orvex-backup.cron
[[ -f "$schedule" ]]
tmp=$(mktemp)
trap 'rm -f -- "$tmp"' EXIT
{ crontab -l 2>/dev/null || true; } | awk '$0 !~ /# orvex-db-backup$/ { print }' >"$tmp"
cat "$schedule" >>"$tmp"
crontab "$tmp"
REMOTE_BACKUP_SCHEDULE
  }

  rollback_release() {
    echo "[deploy] rolling back staged release" >&2
    local failed=0
    if ! set_drain; then
      echo "[deploy] CRITICAL: could not re-enable the drain before rollback" >&2
      return 1
    fi
    if ! "${SSH[@]}" 'pm2 stop velatrix-review >/dev/null'; then
      echo "[deploy] CRITICAL: rollback PM2 stop failed; refusing to restore files under a running app" >&2
      return 1
    fi
    if ! "${SSH[@]}" bash -s -- "$REMOTE_DIR" "$BACKUP_DIR" <<'REMOTE_ROLLBACK'
set -euo pipefail
live=$1
backup=$2
rsync -a --delete-delay \
  --include '.env.example' \
  --exclude '.git/' --exclude '.DS_Store' --exclude '.env' --exclude '.env.*' \
  --exclude '.data/' --exclude 'node_modules/' --exclude 'dist/' --exclude 'build/' \
  --exclude '*.pem' --exclude '*.key' --exclude '*.db' --exclude '*.db-*' \
  --exclude '*.sqlite' --exclude '*.sqlite3' "$backup/" "$live/"
if [[ -d "$live/node_modules" ]]; then rm -rf "$live/node_modules.failed"; mv "$live/node_modules" "$live/node_modules.failed"; fi
if [[ -d "$backup/node_modules" ]]; then mv "$backup/node_modules" "$live/node_modules"; fi
REMOTE_ROLLBACK
    then
      echo "[deploy] CRITICAL: rollback file restoration failed" >&2
      failed=1
    fi
    if ! restart_release; then
      echo "[deploy] CRITICAL: rollback PM2 restart failed" >&2
      failed=1
    elif ! ready_json "${DEPLOY_READY_ATTEMPTS:-30}" "${DEPLOY_READY_SLEEP_S:-2}" 0 1 "$PREVIOUS_RELEASE_ID" >/dev/null; then
      echo "[deploy] CRITICAL: rollback release did not become ready" >&2
      failed=1
    fi
    return "$failed"
  }

  if ! apply_release; then
    if ! rollback_release; then exit 20; fi
    exit 6
  fi
  if ! restart_release; then
    if ! rollback_release; then exit 20; fi
    exit 7
  fi

  READY_ATTEMPTS=${DEPLOY_READY_ATTEMPTS:-30}
  READY_SLEEP_S=${DEPLOY_READY_SLEEP_S:-2}
  if ! ready_json "$READY_ATTEMPTS" "$READY_SLEEP_S" 0 1 "$RELEASE_ID" >/dev/null; then
    if ! rollback_release; then exit 20; fi
    exit 8
  fi
  if ! install_backup_schedule; then
    echo "[deploy] CRITICAL: could not install the local database backup schedule" >&2
    if ! rollback_release; then exit 20; fi
    exit 11
  fi
  if ! clear_drain; then
    echo "[deploy] drain release failed; restoring the previous release" >&2
    if ! rollback_release; then exit 20; fi
    exit 10
  fi
  if ! ready_json "$READY_ATTEMPTS" "$READY_SLEEP_S" 1 0 "$RELEASE_ID" >/dev/null; then
    echo "[deploy] app did not report healthy after releasing drain; preserving the new release under drain for investigation" >&2
    if ! set_drain; then
      echo "[deploy] CRITICAL: could not re-enable the drain after the post-release health failure" >&2
    fi
    exit 9
  fi
  "${SSH[@]}" bash -s -- "$STAGE_DIR" "$BACKUP_DIR" <<'REMOTE_CLEAN'
set -euo pipefail
# Keep the previous source release available for an immediate rollback. The
# next deployment rotates this directory only after its own staged release is
# healthy; deleting it here made a failed post-deploy check unrecoverable.
rm -rf "$1"
REMOTE_CLEAN
  echo "[deploy] staged release is live and healthy"
  exit 0
fi

# Bare rsync without drain/stage is only for --dry-run inspection. Never write
# straight to the live tree during reviews — that path tore packages mid-run.
if ((${#DRY_RUN[@]} == 0)); then
  echo "[deploy] refusing live sync without --restart (use --dry-run to inspect, or --restart to stage+drain)" >&2
  exit 2
fi
"${cmd[@]}"
