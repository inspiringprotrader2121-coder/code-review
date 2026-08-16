#!/usr/bin/env bash
# Provision the credential-isolated OpenAI egress broker used only by the
# internal Codex sandbox. The actual key is never an image layer, Docker env,
# command-line argument, or script output.
set -euo pipefail
IFS=$'\n\t'

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TARGET_USER="orvex"
ENV_FILE="/home/orvex/code-review/.env"
MODE="dry-run"
UPDATE_PINNED_IMAGE=0
IMAGE_TAG="orvex-agentic-egress:local"
ROLLBACK_IMAGE_TAG="${IMAGE_TAG}-rollback"
INTERNAL_NETWORK="orvex-agentic-internal"
EGRESS_NETWORK="orvex-agentic-egress"
BROKER_NAME="orvex-openai-egress"
PIN_UPDATE_TMP=""
PIN_RELOCK_ENV=0

cleanup_private_state() {
  local status=$?
  if [[ -n ${SECRET_FILE:-} ]]; then
    rm -f -- "$SECRET_FILE" "$SECRET_FILE.tmp" 2>/dev/null || true
  fi
  if [[ -n ${PIN_UPDATE_TMP:-} ]]; then
    rm -f -- "$PIN_UPDATE_TMP" 2>/dev/null || true
  fi
  if ((PIN_RELOCK_ENV)); then
    chattr +i -- "$ENV_FILE" 2>/dev/null || true
  fi
  return "$status"
}

trap cleanup_private_state EXIT
trap 'cleanup_private_state; exit 1' HUP INT TERM

usage() {
  cat <<'EOF'
Usage:
  provision-agentic-sandbox.sh [--dry-run] [--user USER] [--env-file FILE]
  provision-agentic-sandbox.sh --apply [--user USER] [--env-file FILE] [--image-tag TAG]
  provision-agentic-sandbox.sh --apply --update-pinned-image [--user USER] [--env-file FILE] [--image-tag TAG]

The default is a non-mutating dry run. --apply builds the digest-pinned local
broker image, creates the two rootless Docker networks, and starts the named
broker. It reads the existing immutable service environment without printing
it. The configured ORVEX_CODEX_EGRESS_BROKER_IMAGE must exactly equal the
locally built immutable image ID before anything is started.

--update-pinned-image is root-only and may be used only with --apply during a
drained, guarded release. It atomically changes exactly the broker image-digest
line in the immutable environment, restores its immutable flag, and restores
the previous pin and broker if the new broker fails its health check.
EOF
}

fail() { printf '[orvex-agentic-egress] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[orvex-agentic-egress] %s\n' "$*"; }

while (($#)); do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --user) shift; (($#)) || fail '--user requires an account'; TARGET_USER=$1 ;;
    --env-file) shift; (($#)) || fail '--env-file requires a path'; ENV_FILE=$1 ;;
    --image-tag) shift; (($#)) || fail '--image-tag requires a tag'; IMAGE_TAG=$1 ;;
    --update-pinned-image) UPDATE_PINNED_IMAGE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
  shift
done

if ((UPDATE_PINNED_IMAGE)); then
  [[ $MODE == apply ]] || fail '--update-pinned-image requires --apply'
  [[ ${EUID:-$(id -u)} -eq 0 ]] || fail '--update-pinned-image must run as root'
fi

[[ $TARGET_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'invalid Unix account'
getent passwd "$TARGET_USER" >/dev/null || fail "Unix account does not exist: $TARGET_USER"
TARGET_UID=$(id -u "$TARGET_USER")
TARGET_HOME=$(getent passwd "$TARGET_USER" | awk -F: '{print $6}')
RUNTIME_DIR="/run/user/$TARGET_UID"
STATE_DIR="$RUNTIME_DIR/orvex-agentic-egress"
SECRET_FILE="$STATE_DIR/openai-api-key"
SIGNING_KEY_FILE="$STATE_DIR/broker-signing-key"
RECORD_FILE="$STATE_DIR/broker-image.digest"
DOCKER_HOST="unix://$RUNTIME_DIR/docker.sock"

[[ -r $ENV_FILE ]] || fail "immutable service environment is not readable: $ENV_FILE"
[[ -S "$RUNTIME_DIR/docker.sock" ]] || fail "rootless Docker socket is unavailable for $TARGET_USER"

as_service_user() {
  runuser -u "$TARGET_USER" -- env \
    HOME="$TARGET_HOME" XDG_RUNTIME_DIR="$RUNTIME_DIR" DOCKER_HOST="$DOCKER_HOST" \
    PATH="$TARGET_HOME/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

assert_rootless_docker() {
  as_service_user docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' 2>/dev/null | grep -Eq '(^|=)rootless$' ||
    fail 'selected Docker daemon is not rootless'
}

read_nonsecret_configured_image() {
  as_service_user bash -c '
    set -a
    source "$1"
    set +a
    : "${ORVEX_OPENAI_API_KEY:=${OPENAI_API_KEY:-}}"
    : "${ORVEX_OPENAI_API_KEY:?missing OpenAI API key}"
    : "${ORVEX_CODEX_EGRESS_BROKER_IMAGE:?missing broker image digest}"
    printf "%s" "$ORVEX_CODEX_EGRESS_BROKER_IMAGE"
  ' bash "$ENV_FILE"
}

rewrite_broker_image_pin() {
  local image=$1 attributes line_count owner mode
  [[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'refusing to write an invalid broker image ID'
  attributes=$(lsattr -d -- "$ENV_FILE" | awk '{print $1}')
  [[ $attributes == *i* ]] || fail 'service environment must be immutable before updating its broker image pin'
  line_count=$(grep -Ec '^ORVEX_CODEX_EGRESS_BROKER_IMAGE=sha256:[a-f0-9]{64}$' "$ENV_FILE" || true)
  [[ $line_count == 1 ]] || fail 'service environment must contain exactly one valid broker image pin'
  owner=$(stat -c '%u:%g' "$ENV_FILE")
  mode=$(stat -c '%a' "$ENV_FILE")
  PIN_UPDATE_TMP=$(mktemp "${ENV_FILE}.orvex-broker-pin.XXXXXX")
  if ! awk -v image="$image" '
    /^ORVEX_CODEX_EGRESS_BROKER_IMAGE=/ {
      print "ORVEX_CODEX_EGRESS_BROKER_IMAGE=" image
      next
    }
    { print }
  ' "$ENV_FILE" > "$PIN_UPDATE_TMP"; then
    fail 'could not prepare the broker image-pin update'
  fi
  chown "$owner" "$PIN_UPDATE_TMP"
  chmod "$mode" "$PIN_UPDATE_TMP"
  chattr -i -- "$ENV_FILE" || fail 'could not temporarily unlock the immutable service environment'
  PIN_RELOCK_ENV=1
  mv -f -- "$PIN_UPDATE_TMP" "$ENV_FILE" || fail 'could not atomically update the broker image pin'
  PIN_UPDATE_TMP=""
  chattr +i -- "$ENV_FILE" || fail 'broker image pin was updated but could not be re-locked as immutable'
  PIN_RELOCK_ENV=0
}

resolve_rollback_image() {
  local current image running rollback
  if as_service_user docker image inspect "$CONFIGURED_IMAGE" >/dev/null 2>&1; then
    printf '%s' "$CONFIGURED_IMAGE"
    return
  fi
  current=$(as_service_user docker inspect --format '{{.Image}} {{.State.Running}}' "$BROKER_NAME" 2>/dev/null || true)
  IFS=' ' read -r image running <<<"$current"
  [[ $image == "$CONFIGURED_IMAGE" && $running == true ]] ||
    fail 'previous configured broker image is unavailable and no matching running broker can be snapshotted'
  if ! as_service_user docker commit --pause=false "$BROKER_NAME" "$ROLLBACK_IMAGE_TAG" >/dev/null; then
    # A running rootless container can still be exported when its historical
    # image content has been garbage-collected, so retain a rollback image.
    as_service_user docker export "$BROKER_NAME" |
      as_service_user docker import - "$ROLLBACK_IMAGE_TAG" >/dev/null ||
      fail 'could not export the running broker for rollback'
    log 'configured broker image was unavailable; exported the running broker for rollback' >&2
  fi
  rollback=$(as_service_user docker image inspect --format '{{.Id}}' "$ROLLBACK_IMAGE_TAG")
  [[ $rollback =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'rollback broker snapshot did not return an immutable image ID'
  log 'configured broker image was unavailable; created a local rollback snapshot of the running broker' >&2
  printf '%s' "$rollback"
}

check_network() {
  local network=$1 expected_internal=$2
  local actual
  actual=$(as_service_user docker network inspect --format '{{.Internal}}' "$network" 2>/dev/null || true)
  [[ -z $actual || $actual == "$expected_internal" ]] || fail "network $network has the wrong internal setting"
}

ensure_network() {
  local network=$1 mode=$2
  if as_service_user docker network inspect "$network" >/dev/null 2>&1; then
    return
  fi
  if [[ $mode == internal ]]; then
    as_service_user docker network create --internal --attachable "$network" >/dev/null
  else
    as_service_user docker network create --attachable "$network" >/dev/null
  fi
}

prepare_secret_mount() {
  as_service_user bash -c '
    set -a
    source "$1"
    set +a
    key=${ORVEX_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}
    [[ -n $key ]] || exit 64
    umask 077
    mkdir -p "$2"
    chmod 0700 "$2"
    printf "%s" "$key" > "$3.tmp"
    chmod 0400 "$3.tmp"
    mv -f "$3.tmp" "$3"
    unset key ORVEX_OPENAI_API_KEY OPENAI_API_KEY
  ' bash "$ENV_FILE" "$STATE_DIR" "$SECRET_FILE" || fail 'could not prepare private broker credential mount'
}

prepare_signing_key() {
  as_service_user bash -c '
    set -euo pipefail
    umask 077
    mkdir -p "$1"
    chmod 0700 "$1"
    if [[ ! -e $2 ]]; then
      openssl rand -hex 32 > "$2.tmp"
      chmod 0400 "$2.tmp"
      mv "$2.tmp" "$2"
    fi
    [[ -f $2 && ! -L $2 ]] || exit 65
    chmod 0400 "$2"
  ' bash "$STATE_DIR" "$SIGNING_KEY_FILE" || fail 'could not prepare private broker signing key'
}

wait_for_healthy() {
  local status
  for _ in $(seq 1 20); do
    status=$(as_service_user docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$BROKER_NAME" 2>/dev/null || true)
    [[ $status == healthy ]] && return 0
    [[ $status == unhealthy || -z $status ]] && break
    sleep 1
  done
  return 1
}

start_broker() {
  local image=$1
  as_service_user docker rm -f "$BROKER_NAME" >/dev/null 2>&1 || true
  as_service_user docker run --detach --name "$BROKER_NAME" --pull never \
    --label orvex.managed=true --label orvex.agentic-egress=true \
    --network "$INTERNAL_NETWORK" --read-only --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
    --cap-drop ALL --security-opt no-new-privileges --ipc none --pids-limit 512 \
    --memory 2g --memory-swap 2g --cpus 2.00 --ulimit nofile=65536:65536 \
    --mount "type=bind,src=$SECRET_FILE,dst=/run/secrets/openai_api_key,readonly,bind-propagation=rprivate" \
    --mount "type=bind,src=$SIGNING_KEY_FILE,dst=/run/secrets/broker_signing_key,readonly,bind-propagation=rprivate" \
    --env OPENAI_API_KEY_FILE=/run/secrets/openai_api_key \
    --env EGRESS_SIGNING_KEY_FILE=/run/secrets/broker_signing_key \
    --env EGRESS_LISTEN_PORT=8080 --env EGRESS_ALLOWED_HOST="$BROKER_NAME" \
    --env EGRESS_MAX_CONTENT_BYTES=1048576 --env EGRESS_MAX_OUTPUT_TOKENS=128000 \
    --env EGRESS_MAX_CONCURRENT=10000 --env EGRESS_MAX_REQUESTS_PER_WINDOW=10000 \
    --env EGRESS_RATE_WINDOW_MS=60000 --env EGRESS_BODY_READ_TIMEOUT_MS=30000 \
    --env EGRESS_UPSTREAM_TIMEOUT_MS=300000 \
    --env EGRESS_MAX_RESPONSE_BYTES=8388608 \
    "$image" >/dev/null || return 1
  as_service_user docker network connect "$EGRESS_NETWORK" "$BROKER_NAME" || return 1
  wait_for_healthy
}

assert_rootless_docker
check_network "$INTERNAL_NETWORK" true
check_network "$EGRESS_NETWORK" false
CONFIGURED_IMAGE=$(read_nonsecret_configured_image) || fail 'immutable service environment is missing required broker configuration'
[[ $CONFIGURED_IMAGE =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'immutable service environment contains an invalid broker image ID'

if [[ $MODE == dry-run ]]; then
  log "DRY RUN: would build $IMAGE_TAG from infra/agentic-egress with --pull=false, --provenance=false and --network none"
  log "DRY RUN: would ensure internal network $INTERNAL_NETWORK and egress network $EGRESS_NETWORK"
  log "DRY RUN: would create a private temporary API-key mount and persistent private capability-signing key for $BROKER_NAME"
  log "DRY RUN: configured broker image is present and will be compared to the locally built image ID during --apply"
  exit 0
fi

as_service_user docker build --pull=false --provenance=false --network none --tag "$IMAGE_TAG" "$ROOT/infra/agentic-egress" >/dev/null
IMAGE_ID=$(as_service_user docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
[[ $IMAGE_ID =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'broker build did not return an immutable image ID'
as_service_user mkdir -p "$STATE_DIR"
as_service_user chmod 0700 "$STATE_DIR"
PIN_UPDATED=0
ROLLBACK_IMAGE="$CONFIGURED_IMAGE"
if [[ $CONFIGURED_IMAGE != "$IMAGE_ID" ]]; then
  ((UPDATE_PINNED_IMAGE)) || fail "ORVEX_CODEX_EGRESS_BROKER_IMAGE does not equal the built broker image ID ($IMAGE_ID); update immutable configuration through the approved operator process before retrying"
  ROLLBACK_IMAGE=$(resolve_rollback_image)
  rewrite_broker_image_pin "$IMAGE_ID"
  PIN_UPDATED=1
fi

ensure_network "$INTERNAL_NETWORK" internal
ensure_network "$EGRESS_NETWORK" egress
prepare_secret_mount
prepare_signing_key

if ! start_broker "$IMAGE_ID"; then
  if ((PIN_UPDATED)); then
    log 'new broker failed its private health check; restoring the previous pinned broker'
    rewrite_broker_image_pin "$ROLLBACK_IMAGE"
    start_broker "$ROLLBACK_IMAGE" || fail 'new broker failed and the previous broker could not be restored'
  fi
  fail 'broker failed its private health check; inspect rootless Docker logs without printing environment data'
fi
printf '%s\n' "$IMAGE_ID" | as_service_user tee "$RECORD_FILE" >/dev/null
as_service_user chmod 0600 "$RECORD_FILE"
log "broker is healthy; immutable image ID recorded at $RECORD_FILE"
