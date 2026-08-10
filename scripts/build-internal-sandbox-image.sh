#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE_TAG=${ORVEX_SANDBOX_BUILD_TAG:-orvex-runtime:node22}
uid=$(id -u)
expected_host="unix:///run/user/$uid/docker.sock"

[[ ${DOCKER_HOST:-} == "$expected_host" ]] || {
  printf '[orvex-sandbox] ERROR: DOCKER_HOST must be %s\n' "$expected_host" >&2
  exit 1
}
docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' 2>/dev/null |
  grep -Eq '(^|=)rootless$' || {
    printf '[orvex-sandbox] ERROR: selected Docker daemon is not rootless\n' >&2
    exit 1
  }

docker build --pull=false --provenance=false --tag "$IMAGE_TAG" "$ROOT/sandbox/runtime"
image_id=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
[[ $image_id =~ ^sha256:[a-f0-9]{64}$ ]] || {
  printf '[orvex-sandbox] ERROR: build returned an invalid image ID\n' >&2
  exit 1
}
docker run --rm --pull never --network none --cap-drop ALL \
  --security-opt no-new-privileges --env CODEX_HOME=/tmp/codex-home "$image_id" \
  sh -c 'mkdir -p "$CODEX_HOME" && chmod 700 "$CODEX_HOME" && node --version && npm --version && pnpm --version && yarn --version && node /opt/orvex/node_modules/@openai/codex/bin/codex.js --version' >/dev/null

printf '%s\n' "$image_id"
