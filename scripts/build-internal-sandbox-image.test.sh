#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/build-internal-sandbox-image.sh"
DOCKERFILE="$ROOT/sandbox/runtime/Dockerfile"

bash -n "$SCRIPT"
grep -Eq '^ARG BASE_IMAGE=[^[:space:]]+@sha256:[a-f0-9]{64}$' "$DOCKERFILE"
grep -q 'corepack prepare pnpm@11.7.0 --activate' "$DOCKERFILE"
grep -q 'corepack prepare yarn@1.22.22 --activate' "$DOCKERFILE"
grep -q '^ARG CODEX_VERSION=0.147.0$' "$DOCKERFILE"
grep -q 'npm install --prefix /opt/orvex' "$DOCKERFILE"
grep -q '/opt/orvex/node_modules/@openai/codex/bin/codex.js --version' "$SCRIPT"
grep -q -- '--env CODEX_HOME=/tmp/codex-home' "$SCRIPT"
grep -q 'mkdir -p "$CODEX_HOME" && chmod 700 "$CODEX_HOME"' "$SCRIPT"
grep -q 'orvex.codex-version' "$ROOT/sandbox/runtime/Dockerfile"
node - <<'NODE'
const { readFileSync } = require('node:fs');
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const dockerfile = readFileSync('sandbox/runtime/Dockerfile', 'utf8');
const version = dockerfile.match(/^ARG CODEX_VERSION=(.+)$/m)?.[1];
if (!version || root.dependencies?.['@openai/codex'] !== version) {
  throw new Error('sandbox Codex version must equal the pinned application dependency');
}
NODE
grep -q 'DOCKER_HOST must be' "$SCRIPT"
grep -q "grep -Eq '(^|=)rootless\$'" "$SCRIPT"
grep -q -- '--pull=false' "$SCRIPT"
grep -q -- '--provenance=false' "$SCRIPT"
grep -q -- '--network none' "$SCRIPT"
grep -q -- '--cap-drop ALL' "$SCRIPT"

printf 'build-internal-sandbox-image static tests passed\n'
