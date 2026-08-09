# ADR 0002: Fresh Linux Build Gate

## Status

Accepted.

## Context

The development machine can contain platform-specific native binaries or cached dependencies that conceal production failures. Production runs Linux and depends on native SQLite and binary tooling packages.

## Decision

CI runs a separate Ubuntu 24.04 job that creates a fresh archive checkout, performs a frozen pnpm 11 install, runs policy checks, typechecking, tests including Redis integration, compilation, and imports every declared compiled export.

## Consequences

The gate adds CI time and does not prove third-party provider behavior. It does prove that the committed dependency graph can be installed and exercised on a clean Linux runtime before deployment.
