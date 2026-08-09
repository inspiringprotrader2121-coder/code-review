#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/provision-agentic-sandbox.sh"
DOCKERFILE="$ROOT/infra/agentic-egress/Dockerfile"
BROKER="$ROOT/infra/agentic-egress/broker.mjs"

bash -n "$SCRIPT"
node --check "$BROKER"
"$SCRIPT" --help >/dev/null

rg -q '^ARG BASE_IMAGE=[^[:space:]]+@sha256:[a-f0-9]{64}$' "$DOCKERFILE"
rg -q -- '--network none' "$SCRIPT"
rg -q -- '--internal --attachable' "$SCRIPT"
rg -q -- '--read-only' "$SCRIPT"
rg -q -- '--cap-drop ALL' "$SCRIPT"
rg -q -- '--security-opt no-new-privileges' "$SCRIPT"
rg -q -- '--ipc none' "$SCRIPT"
rg -q -- 'OPENAI_API_KEY_FILE=/run/secrets/openai_api_key' "$SCRIPT"
rg -q -- 'EGRESS_SIGNING_KEY_FILE=/run/secrets/broker_signing_key' "$SCRIPT"
rg -q 'broker-signing-key' "$SCRIPT"
if rg -n -- '--env OPENAI_API_KEY=|--env ORVEX_OPENAI_API_KEY=|printf.*ORVEX_OPENAI_API_KEY' "$SCRIPT"; then
  printf 'broker provisioning must not pass or print the real API key via Docker or stdout\n' >&2
  exit 1
fi
rg -q 'unset key ORVEX_OPENAI_API_KEY OPENAI_API_KEY' "$SCRIPT"
rg -q 'ORVEX_CODEX_EGRESS_BROKER_IMAGE does not equal the built broker image ID' "$SCRIPT"
rg -q 'broker-image.digest' "$SCRIPT"
rg -q "hostname: OPENAI_HOST" "$BROKER"
rg -q "path: OPENAI_RESPONSES_PATH" "$BROKER"
rg -q "REQUIRED_MODEL = 'gpt-5.6-luna'" "$BROKER"
rg -q "REQUIRED_REASONING_EFFORT = 'max'" "$BROKER"

printf 'provision-agentic-sandbox static tests passed\n'
