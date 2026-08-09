#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/build-internal-sandbox-image.sh"
DOCKERFILE="$ROOT/sandbox/runtime/Dockerfile"

bash -n "$SCRIPT"
grep -Eq '^ARG BASE_IMAGE=[^[:space:]]+@sha256:[a-f0-9]{64}$' "$DOCKERFILE"
grep -q 'corepack prepare pnpm@11.7.0 --activate' "$DOCKERFILE"
grep -q 'corepack prepare yarn@1.22.22 --activate' "$DOCKERFILE"
grep -q 'DOCKER_HOST must be' "$SCRIPT"
grep -q "grep -Eq '(^|=)rootless\$'" "$SCRIPT"
grep -q -- '--pull=false' "$SCRIPT"
grep -q -- '--provenance=false' "$SCRIPT"
grep -q -- '--network none' "$SCRIPT"
grep -q -- '--cap-drop ALL' "$SCRIPT"

printf 'build-internal-sandbox-image static tests passed\n'
