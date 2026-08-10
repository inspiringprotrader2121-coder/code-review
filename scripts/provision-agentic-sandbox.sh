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
IMAGE_TAG="orvex-agentic-egress:local"
INTERNAL_NETWORK="orvex-agentic-internal"
EGRESS_NETWORK="orvex-agentic-egress"
BROKER_NAME="orvex-openai-egress"

usage() {
  cat <<'EOF'
Usage:
  provision-agentic-sandbox.sh [--dry-run] [--user USER] [--env-file FILE]
  provision-agentic-sandbox.sh --apply [--user USER] [--env-file FILE] [--image-tag TAG]

The default is a non-mutating dry run. --apply builds the digest-pinned local
broker image, creates the two rootless Docker networks, and starts the named
broker. It reads the existing immutable service environment without printing
it. The configured ORVEX_CODEX_EGRESS_BROKER_IMAGE must exactly equal the
locally built immutable image ID before anything is started.
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
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
  shift
done

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

assert_rootless_docker
check_network "$INTERNAL_NETWORK" true
check_network "$EGRESS_NETWORK" false
CONFIGURED_IMAGE=$(read_nonsecret_configured_image) || fail 'immutable service environment is missing required broker configuration'

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
[[ $CONFIGURED_IMAGE == "$IMAGE_ID" ]] || fail "ORVEX_CODEX_EGRESS_BROKER_IMAGE does not equal the built broker image ID ($IMAGE_ID); update immutable configuration through the approved operator process before retrying"

ensure_network "$INTERNAL_NETWORK" internal
ensure_network "$EGRESS_NETWORK" egress
prepare_secret_mount
prepare_signing_key
cleanup_secret() { rm -f "$SECRET_FILE" "$SECRET_FILE.tmp"; }
trap cleanup_secret EXIT

as_service_user docker rm -f "$BROKER_NAME" >/dev/null 2>&1 || true
as_service_user docker run --detach --name "$BROKER_NAME" --pull never \
  --label orvex.managed=true --label orvex.agentic-egress=true \
  --network "$INTERNAL_NETWORK" --read-only --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges --ipc none --pids-limit 64 \
  --memory 256m --memory-swap 256m --cpus 0.50 --ulimit nofile=128:128 \
  --mount "type=bind,src=$SECRET_FILE,dst=/run/secrets/openai_api_key,readonly,bind-propagation=rprivate" \
  --mount "type=bind,src=$SIGNING_KEY_FILE,dst=/run/secrets/broker_signing_key,readonly,bind-propagation=rprivate" \
  --env OPENAI_API_KEY_FILE=/run/secrets/openai_api_key \
  --env EGRESS_SIGNING_KEY_FILE=/run/secrets/broker_signing_key \
  --env EGRESS_LISTEN_PORT=8080 --env EGRESS_ALLOWED_HOST="$BROKER_NAME" \
  --env EGRESS_MAX_CONTENT_BYTES=1048576 --env EGRESS_MAX_OUTPUT_TOKENS=65536 \
  --env EGRESS_MAX_CONCURRENT=8 --env EGRESS_MAX_REQUESTS_PER_WINDOW=24 \
  --env EGRESS_RATE_WINDOW_MS=60000 --env EGRESS_BODY_READ_TIMEOUT_MS=30000 \
  --env EGRESS_UPSTREAM_TIMEOUT_MS=300000 \
  --env EGRESS_MAX_RESPONSE_BYTES=8388608 \
  "$IMAGE_ID" >/dev/null
as_service_user docker network connect "$EGRESS_NETWORK" "$BROKER_NAME"
wait_for_healthy || fail 'broker failed its private health check; inspect rootless Docker logs without printing environment data'
printf '%s\n' "$IMAGE_ID" | as_service_user tee "$RECORD_FILE" >/dev/null
as_service_user chmod 0600 "$RECORD_FILE"
cleanup_secret
trap - EXIT
log "broker is healthy; immutable image ID recorded at $RECORD_FILE"
