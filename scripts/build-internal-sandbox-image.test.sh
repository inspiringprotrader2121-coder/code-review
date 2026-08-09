#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/build-internal-sandbox-image.sh"
DOCKERFILE="$ROOT/sandbox/runtime/Dockerfile"

bash -n "$SCRIPT"
grep -Eq '^ARG BASE_IMAGE=[^[:space:]]+@sha256:[a-f0-9]{64}$' "$DOCKERFILE"
grep -q 'npm install --global --ignore-scripts --no-audit --no-fund' "$DOCKERFILE"
grep -q 'pnpm@11.7.0 yarn@1.22.22' "$DOCKERFILE"
grep -q 'DOCKER_HOST must be' "$SCRIPT"
grep -q "grep -Eq '(^|=)rootless\$'" "$SCRIPT"
grep -q -- '--pull=false' "$SCRIPT"
grep -q -- '--network none' "$SCRIPT"
grep -q -- '--cap-drop ALL' "$SCRIPT"

printf 'build-internal-sandbox-image static tests passed\n'
