#!/usr/bin/env bash
# Provision or assess the host prerequisites for Orvex's internal rootless-Docker
# runtime sandbox. This script intentionally never reads .env or prints an
# environment, so service credentials cannot appear in its output.
set -euo pipefail
IFS=$'\n\t'

TARGET_USER="orvex"
MODE="check"
ALLOW_EXISTING_ROOT_DAEMON=0
PRIVATE_LOG="/var/log/orvex-sandbox-provision.log"

usage() {
  cat <<'EOF'
Usage:
  provision-internal-sandbox.sh [--check] [--user USER]
  provision-internal-sandbox.sh --apply [--user USER] [--allow-existing-root-daemon]

Read-only preflight is the default. It reports whether this host can run the
internal rootless-Docker sandbox for USER without changing host state.

--apply requires root and installs only Docker's documented rootless
prerequisites, gives USER subordinate IDs, enables that user's systemd linger,
and requires the packaged rootlesskit AppArmor profile. It never creates an
unconfined fallback, disables AppArmor, or changes global user-namespace
sysctls.

When a rootful Docker daemon is already active, --allow-existing-root-daemon is
required. The rootful daemon is left running; Docker's rootless installer is
called with --force only to create USER's separate rootless daemon/socket.
EOF
}

log() {
  printf '[orvex-sandbox] %s\n' "$*"
}

fail() {
  printf '[orvex-sandbox] ERROR: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf '[orvex-sandbox] WARN: %s\n' "$*" >&2
}

while (($#)); do
  case "$1" in
    --check)
      MODE="check"
      ;;
    --apply)
      MODE="apply"
      ;;
    --user)
      shift
      (($#)) || fail "--user requires an account name"
      TARGET_USER=$1
      ;;
    --allow-existing-root-daemon)
      ALLOW_EXISTING_ROOT_DAEMON=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

[[ $TARGET_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "invalid Unix account name"
getent passwd "$TARGET_USER" >/dev/null || fail "Unix account does not exist: $TARGET_USER"
TARGET_UID=$(id -u "$TARGET_USER")
TARGET_HOME=$(getent passwd "$TARGET_USER" | awk -F: '{print $6}')
[[ -n $TARGET_HOME && -d $TARGET_HOME ]] || fail "cannot determine home directory for $TARGET_USER"
RUNTIME_DIR="/run/user/$TARGET_UID"

has_subid_range() {
  local file=$1
  awk -F: -v user="$TARGET_USER" '
    $1 == user && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $3 >= 65536 { ok = 1 }
    END { exit(ok ? 0 : 1) }
  ' "$file" 2>/dev/null
}

next_subid_start() {
  local file=$1
  awk -F: '
    BEGIN { high = 100000; block = 65536 }
    $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {
      end = $2 + $3
      if (end > high) high = end
    }
    END {
      rem = high % block
      if (rem != 0) high += block - rem
      print high
    }
  ' "$file"
}

rootlesskit_path() {
  local candidate
  for candidate in "$TARGET_HOME/bin/rootlesskit" /usr/bin/rootlesskit /usr/local/bin/rootlesskit; do
    [[ -x $candidate ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

apparmor_allows_rootlesskit() {
  local binary=$1
  command -v aa-status >/dev/null 2>&1 || return 1
  aa-status --profiled 2>/dev/null | grep -Eq "(^|/)(rootlesskit|$(basename "$binary"))$"
}

rootless_docker_ready() {
  [[ -S "$RUNTIME_DIR/docker.sock" ]] || return 1
  runuser -u "$TARGET_USER" -- env \
    HOME="$TARGET_HOME" \
    XDG_RUNTIME_DIR="$RUNTIME_DIR" \
    DOCKER_HOST="unix://$RUNTIME_DIR/docker.sock" \
    PATH="$TARGET_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
    docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' 2>/dev/null | grep -Eq '(^|=)rootless$'
}

check() {
  local failures=0
  local rootlesskit=""

  log "read-only preflight for user $TARGET_USER (uid $TARGET_UID)"
  if [[ $(uname -s) != Linux ]]; then
    warn "this workflow supports Linux hosts only"
    return 1
  fi
  if command -v newuidmap >/dev/null 2>&1 && command -v newgidmap >/dev/null 2>&1; then
    log "PASS uidmap helpers are installed"
  else
    warn "FAIL uidmap helpers (newuidmap/newgidmap) are missing"
    failures=1
  fi
  if has_subid_range /etc/subuid && has_subid_range /etc/subgid; then
    log "PASS subordinate UID/GID ranges are at least 65536 IDs"
  else
    warn "FAIL $TARGET_USER needs >=65536 IDs in both /etc/subuid and /etc/subgid"
    failures=1
  fi
  if command -v loginctl >/dev/null 2>&1 && loginctl show-user "$TARGET_USER" -p Linger --value 2>/dev/null | grep -qx yes; then
    log "PASS systemd linger is enabled for $TARGET_USER"
  else
    warn "FAIL systemd linger is not enabled for $TARGET_USER"
    failures=1
  fi
  if command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
    log "PASS Docker rootless setup tool is installed"
  else
    warn "FAIL dockerd-rootless-setuptool.sh is missing (install docker-ce-rootless-extras from Docker's official repository)"
    failures=1
  fi
  if rootlesskit=$(rootlesskit_path); then
    if [[ -r /sys/module/apparmor/parameters/enabled ]] && grep -q '^Y' /sys/module/apparmor/parameters/enabled; then
      if apparmor_allows_rootlesskit "$rootlesskit"; then
        log "PASS AppArmor has a profile for rootlesskit"
      else
        warn "FAIL AppArmor is enabled but has no loaded rootlesskit profile for $rootlesskit"
        failures=1
      fi
    else
      warn "FAIL AppArmor is not active; do not weaken it to make sandboxing work"
      failures=1
    fi
  else
    warn "FAIL rootlesskit binary is missing"
    failures=1
  fi
  if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] && [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]; then
    log "PASS Ubuntu user-namespace restriction remains enabled; rootlesskit needs its scoped profile"
  elif [[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
    warn "FAIL global AppArmor user-namespace restriction is disabled; restore it before enabling Orvex sandboxing"
    failures=1
  else
    log "INFO host does not expose Ubuntu's AppArmor user-namespace restriction"
  fi
  if rootless_docker_ready; then
    log "PASS rootless Docker socket is usable by $TARGET_USER"
  else
    warn "FAIL rootless Docker socket is not ready for $TARGET_USER"
    failures=1
  fi
  if command -v bwrap >/dev/null 2>&1; then
    log "INFO bubblewrap is installed; this script does not enable Codex integration"
  else
    log "INFO bubblewrap is absent; it is not required for the current Docker runtime verifier"
  fi

  if ((failures)); then
    warn "preflight is NOT ready. Run as root with --apply only after reviewing docs/INTERNAL_SANDBOX.md."
    return 1
  fi
  log "PASS internal rootless-Docker sandbox host is ready"
}

require_root() {
  [[ $(id -u) -eq 0 ]] || fail "--apply must be run by root; --check is safe for any user"
}

prepare_private_log() {
  touch "$PRIVATE_LOG"
  chown root:root "$PRIVATE_LOG"
  chmod 0600 "$PRIVATE_LOG"
}

run_privately() {
  "$@" >>"$PRIVATE_LOG" 2>&1 || fail "host command failed; inspect $PRIVATE_LOG as root"
}

require_host_security_baseline() {
  [[ -r /sys/module/apparmor/parameters/enabled ]] && grep -q '^Y' /sys/module/apparmor/parameters/enabled ||
    fail "AppArmor must be active before provisioning a sandbox"
  if [[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] &&
    [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns) != 1 ]]; then
    fail "the global AppArmor user-namespace restriction is disabled; restore it before provisioning"
  fi
  command -v apparmor_parser >/dev/null 2>&1 ||
    fail "apparmor_parser is required to load the scoped rootlesskit profile"
}

install_prerequisites() {
  command -v apt-get >/dev/null 2>&1 || fail "automatic apply supports apt-based Linux only; install Docker's rootless prerequisites manually"
  log "installing Docker-documented rootless prerequisites (no repository configuration is changed)"
  run_privately env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  run_privately env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    uidmap dbus-user-session slirp4netns fuse-overlayfs docker-ce-rootless-extras
}

ensure_subid_range() {
  local file=$1
  local flag=$2
  local start end
  if has_subid_range "$file"; then
    log "subordinate range already present in $file"
    return
  fi
  start=$(next_subid_start "$file")
  end=$((start + 65536 - 1))
  log "allocating one 65536-ID subordinate range for $TARGET_USER in $file"
  run_privately usermod "$flag" "$start-$end" "$TARGET_USER"
}

require_packaged_apparmor_profile() {
  local binary
  binary=$(rootlesskit_path) || fail "rootlesskit still missing after prerequisites install"
  if apparmor_allows_rootlesskit "$binary"; then
    log "using Docker/Ubuntu packaged AppArmor rootlesskit profile"
    return
  fi
  fail "packaged rootlesskit AppArmor profile is not loaded; refusing to create an unconfined fallback"
}

install_rootless_daemon() {
  local setup_tool
  if rootless_docker_ready; then
    log "existing rootless Docker daemon is already usable by $TARGET_USER"
    return
  fi
  setup_tool=$(command -v dockerd-rootless-setuptool.sh) || fail "rootless setup tool is unavailable"
  log "installing a separate rootless Docker daemon for $TARGET_USER (installer output is retained privately)"
  runuser -u "$TARGET_USER" -- env \
    HOME="$TARGET_HOME" \
    USER="$TARGET_USER" \
    LOGNAME="$TARGET_USER" \
    XDG_RUNTIME_DIR="$RUNTIME_DIR" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNTIME_DIR/bus" \
    PATH="$TARGET_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
    "$setup_tool" install --force >>"$PRIVATE_LOG" 2>&1
  runuser -u "$TARGET_USER" -- env \
    XDG_RUNTIME_DIR="$RUNTIME_DIR" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNTIME_DIR/bus" \
    systemctl --user enable --now docker.service >>"$PRIVATE_LOG" 2>&1
}

apply() {
  require_root
  [[ $(uname -s) == Linux ]] || fail "--apply supports Linux hosts only"
  if systemctl is-active --quiet docker.service && (( ! ALLOW_EXISTING_ROOT_DAEMON )); then
    fail "rootful docker.service is active; re-run with --allow-existing-root-daemon to preserve it and install a separate rootless daemon"
  fi
  require_host_security_baseline
  prepare_private_log
  install_prerequisites
  ensure_subid_range /etc/subuid --add-subuids
  ensure_subid_range /etc/subgid --add-subgids
  command -v loginctl >/dev/null 2>&1 || fail "loginctl is required for a persistent rootless Docker service"
  log "enabling systemd linger for $TARGET_USER"
  run_privately loginctl enable-linger "$TARGET_USER"
  run_privately systemctl start "user@$TARGET_UID.service"
  require_packaged_apparmor_profile
  install_rootless_daemon
  log "apply completed; re-running read-only preflight"
  check
}

case "$MODE" in
  check) check ;;
  apply) apply ;;
esac
