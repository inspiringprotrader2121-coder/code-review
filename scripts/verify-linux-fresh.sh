#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != 'Linux' ]]; then
  echo '[linux-fresh] this verification is intentionally Linux-only' >&2
  exit 2
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]]; then
  echo '[linux-fresh] refusing to verify a dirty checkout; commit the exact release first' >&2
  exit 2
fi
WORK=$(mktemp -d)
cleanup() { rm -rf -- "$WORK"; }
trap cleanup EXIT

git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$WORK"
cd "$WORK"

corepack pnpm@11.7.0 --pm-on-fail=ignore install --frozen-lockfile
corepack pnpm@11.7.0 --pm-on-fail=ignore format:check
corepack pnpm@11.7.0 --pm-on-fail=ignore check:runtime
corepack pnpm@11.7.0 --pm-on-fail=ignore check:dependencies
corepack pnpm@11.7.0 --pm-on-fail=ignore dedupe --check
corepack pnpm@11.7.0 --pm-on-fail=ignore check:architecture
corepack pnpm@11.7.0 --pm-on-fail=ignore check:docs
corepack pnpm@11.7.0 --pm-on-fail=ignore build
corepack pnpm@11.7.0 --pm-on-fail=ignore check:built-exports
corepack pnpm@11.7.0 --pm-on-fail=ignore typecheck
corepack pnpm@11.7.0 --pm-on-fail=ignore test

echo '[linux-fresh] fresh install, checks, tests, build, and compiled imports passed'
