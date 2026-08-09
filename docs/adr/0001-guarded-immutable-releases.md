# ADR 0001: Guarded Immutable Releases

## Status

Accepted.

## Context

The application has durable tenant data, immutable runtime configuration, Linux-native dependencies, and paid review work. Copying an arbitrary local tree to the server can replace database files, credentials, or macOS-native binaries.

## Decision

Source releases are identified by the committed Git SHA and lockfile SHA-256. `scripts/deploy-safe.sh` materializes only tracked selected source files, stages them remotely, installs and validates dependencies on Linux, drains work, activates under PM2, verifies the exact release ID, and restores the known-good release on failure.

Protected runtime paths remain outside the release: `.env`, `.data`, database files, keys, PEM files, `node_modules`, `dist`, and build output. The production database stays outside the checkout.

## Consequences

Deployments are slower than a raw file copy but are observable and reversible. A dirty checkout, missing previous release identity, unhealthy readiness response, or failed staged check blocks activation. The release identifier is non-secret and can be used in readiness evidence without exposing configuration.
