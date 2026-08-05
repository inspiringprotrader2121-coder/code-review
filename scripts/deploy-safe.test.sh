#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

scripts/deploy-safe.sh --validate-only
scripts/deploy-safe.sh --validate-only .env.example

if [[ $(grep -c -- "--include '.env.example'" scripts/deploy-safe.sh) -ne 5 ]]; then
  echo "deploy must allow .env.example through upload, stage, backup, apply, and rollback" >&2
  exit 1
fi
grep -Fq 'bash -s -- "$REMOTE_DIR" "$STAGE_DIR" "${SOURCES[@]}"' scripts/deploy-safe.sh || {
  echo "deploy does not pass selected sources to isolated stage preparation" >&2
  exit 1
}
grep -Fq 'corepack pnpm@11.7.0 --pm-on-fail=ignore test' scripts/deploy-safe.sh || {
  echo "deploy does not run the full staged test gate" >&2
  exit 1
}
grep -Fq 'rm -rf -- "$stage/$source"' scripts/deploy-safe.sh || {
  echo "deploy stage does not remove stale copies of selected local sources" >&2
  exit 1
}
grep -Fq 'install_backup_schedule' scripts/deploy-safe.sh || {
  echo "deploy does not install the database backup schedule" >&2
  exit 1
}

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
  '  if [[ -e "$DEPLOY_TEST_STATE/restarted" && "${DEPLOY_TEST_POST_READY_FAIL:-0}" == 1 ]]; then exit 22; fi' \
  '  if [[ -e "$DEPLOY_TEST_STATE/restarted" && "${DEPLOY_TEST_POST_READY_MALFORMED:-0}" == 1 ]]; then printf "{\"activeJobs\":0}\n"; exit 0; fi' \
  '  if [[ "${DEPLOY_TEST_OLD_READY:-0}" == 1 && ! -e "$DEPLOY_TEST_STATE/restarted" ]]; then printf "{\"ok\":true}\n"; exit 0; fi' \
  '  if [[ "${DEPLOY_TEST_READY_MODE:-idle}" == busy ]]; then printf "{\"ok\":true,\"activeJobs\":1,\"draining\":true}\n"; elif [[ -e "$DEPLOY_TEST_STATE/restarted" && -e "$DEPLOY_TEST_STATE/drain-cleared" && "${DEPLOY_TEST_POST_READY_BUSY:-0}" == 1 ]]; then printf "{\"ok\":true,\"activeJobs\":1,\"draining\":false}\n"; elif [[ -e "$DEPLOY_TEST_STATE/drain-cleared" ]]; then printf "{\"ok\":true,\"activeJobs\":0,\"draining\":false}\n"; else printf "{\"ok\":true,\"activeJobs\":0,\"draining\":true}\n"; fi' \
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
  '  if [[ "$SCRIPT" == *"startOrRestart"* || "$SCRIPT" == *"pm2 restart"* || "$SCRIPT" == *"pm2 start /usr/bin/bash"* ]]; then : >"$DEPLOY_TEST_STATE/restarted"; fi' \
  '  if [[ "$SCRIPT" == *"touch --"* ]]; then : >"$DEPLOY_TEST_STATE/draining"; fi' \
  '  if [[ "$SCRIPT" == *"rm -f --"* ]]; then : >"$DEPLOY_TEST_STATE/drain-cleared"; fi' \
  '  : >"$DEPLOY_TEST_STATE/installed"' \
  'fi' >"$FAKE_BIN/ssh"
chmod +x "$FAKE_BIN/rsync" "$FAKE_BIN/ssh"

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
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy refused to reclaim a stale deployment lock" >&2
  exit 1
fi
if [[ -e "$STATE/lock-stale" ]]; then
  echo "stale lock marker survived — reclaim path not taken" >&2
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
if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" DEPLOY_TEST_POST_READY_FAIL=1 \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy accepted failed post-restart readiness" >&2
  exit 1
fi

rm -f "$STATE"/*
if PATH="$FAKE_BIN:$PATH" DEPLOY_TEST_STATE="$STATE" DEPLOY_TEST_POST_READY_MALFORMED=1 \
  DEPLOY_READY_ATTEMPTS=2 DEPLOY_READY_SLEEP_S=0 \
  scripts/deploy-safe.sh --restart scripts/deploy-safe.sh >/dev/null 2>&1; then
  echo "deploy accepted malformed post-restart readiness" >&2
  exit 1
fi

echo "deploy-safe tests passed"
