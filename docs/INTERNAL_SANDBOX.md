# Internal Linux Sandbox

Orvex's runtime verifier is designed to run containers on the Orvex server. It
does not require a third-party sandbox service. The host boundary is a separate
rootless Docker daemon owned by the service account, with Docker's built-in
seccomp profile, user namespaces, capability drop and container resource limits.

This is an administrator operation because Ubuntu's user-namespace security
policy and the rootless Docker service are host configuration. The application
does not self-provision the host, and the provisioning workflow deliberately
does not read `.env`, print service configuration, change credentials, or deploy
Orvex.

## What It Does

[`scripts/provision-internal-sandbox.sh`](../scripts/provision-internal-sandbox.sh)
has two deliberately separate modes:

| Command   | Privilege | Effect                                                                                                      |
| --------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `--check` | Any user  | Read-only preflight. No package, service, AppArmor, user, Docker, or environment changes.                   |
| `--apply` | Root only | Installs documented rootless Docker prerequisites, configures the service account, and verifies the result. |

The script targets the `orvex` account by default. Use `--user NAME` only for a
dedicated service account. Do not use a personal administrator account.

```bash
# Read-only: safe to run before any production change.
sudo /home/orvex/code-review/scripts/provision-internal-sandbox.sh --check --user orvex

# Apply only after the preflight and this document have been reviewed.
# The extra acknowledgement is required when a rootful Docker service already exists.
sudo /home/orvex/code-review/scripts/provision-internal-sandbox.sh \
  --apply --user orvex --allow-existing-root-daemon

# Read-only proof after apply.
sudo /home/orvex/code-review/scripts/provision-internal-sandbox.sh --check --user orvex
```

The workflow is idempotent: existing valid subordinate-ID ranges, systemd
linger, a loaded rootlesskit AppArmor profile, and a functioning rootless socket
are retained. It does not stop, disable, or reconfigure an existing rootful
Docker daemon.

## Security Rules

- AppArmor stays enabled. The workflow never writes
  `kernel.apparmor_restrict_unprivileged_userns=0`, never disables AppArmor, and
  never changes a global user-namespace sysctl.
- It installs Docker's documented `uidmap`, `dbus-user-session`, `slirp4netns`,
  `fuse-overlayfs`, and `docker-ce-rootless-extras` packages from an already
  configured official Docker APT repository. It does not add repositories or
  download/install a shell script from the network.
- Ubuntu's package-owned rootlesskit AppArmor policy must be present and parse
  cleanly. The workflow may load that exact packaged file; if it is absent or
  unowned, provisioning stops. The script never manufactures a fallback
  profile or changes the global user-namespace restriction.
- The script does not print environment variables, Docker configuration, API
  keys, tokens, or `.env` content. Package-manager and rootless-installer output
  are written only to `/var/log/orvex-sandbox-provision.log` with mode `0600`.
- A rootless daemon has its own socket at
  `/run/user/<service-uid>/docker.sock`. The rootful `/var/run/docker.sock` is
  intentionally not granted to the `orvex` account.

Docker documents the required `uidmap` helpers and a minimum 65,536-ID
subordinate UID/GID range for rootless mode. It also documents the Ubuntu 24.04
AppArmor behavior and the package-provided `rootlesskit` profile:
[Rootless prerequisites](https://docs.docker.com/engine/security/rootless/),
[Ubuntu troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/).
Ubuntu documents a program-specific `userns` AppArmor profile as the safe
alternative to disabling the global restriction:
[Ubuntu 24.04 release notes](https://documentation.ubuntu.com/release-notes/24.04/).

## Activation Is Separate

Passing host preflight does **not** enable code execution. Enable it only in a
separate, reviewed local configuration change and normal safe deployment:

```bash
# Run as the service account after rootless preflight passes. The final line is
# the immutable local image ID used below.
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
/home/orvex/code-review/scripts/build-internal-sandbox-image.sh

# Read-only broker preflight. In the usual case, after the two image IDs have
# been applied through production configuration management, --apply builds and
# starts the broker without changing runtime configuration.
sudo /home/orvex/code-review/scripts/provision-agentic-sandbox.sh --dry-run
sudo /home/orvex/code-review/scripts/provision-agentic-sandbox.sh --apply

# A broker source update builds a new local image. During a guarded deployment
# while the review worker is drained, this root-only option atomically changes
# only ORVEX_CODEX_EGRESS_BROKER_IMAGE, restores the immutable file flag, and
# restores the previous functioning broker if the new broker is unhealthy. If
# Docker has already removed the old image record, it snapshots the currently
# running read-only broker; when a normal Docker snapshot cannot be created, it
# safely exports and imports that running broker as the rollback image.
sudo /home/orvex/code-review/scripts/provision-agentic-sandbox.sh --apply --update-pinned-image
```

```dotenv
# Rootless Docker socket for the Orvex service account. Replace <uid> with the
# numeric UID reported by `id -u orvex`; do not put credentials in this value.
DOCKER_HOST=unix:///run/user/<uid>/docker.sock

# Keep disabled until the rootless preflight passes and the deployment has been
# reviewed. Existing application checks still decide which plan can execute.
ORVEX_CODE_EXECUTION=1

# Required: an already-loaded, reviewed image pinned by content digest. The
# image must contain approved package-manager binaries and offline dependency
# caches; customer lockfiles receive no network egress.
ORVEX_SANDBOX_IMAGE=sha256:<64-hex-local-image-id>

# Run Codex/Luna inside the same rootless boundary. The agent container receives
# a short-lived signed capability, never the upstream OpenAI API key.
ORVEX_CODEX_CONTAINER_RUNTIME=1
ORVEX_CODEX_EGRESS_BROKER_IMAGE=sha256:<64-hex-local-image-id>
```

The production `.env` is immutable by design. Use the existing approved
configuration-management and guarded deployment workflow; do not edit the live
server as a one-off and do not run raw `rsync`. The only controlled exception is
the root-only `--apply --update-pinned-image` operation above, which replaces
exactly one validated broker-image digest during a drained broker release and
immediately restores the immutable flag.

Both local image builders disable BuildKit provenance wrappers. These images
never leave the server, and omitting the generated attestation manifest keeps
an unchanged build's local image ID reproducible between the initial build used
to prepare configuration and the broker's guarded apply-time rebuild.

The runtime image also contains the same pinned Codex CLI version as the
application dependency. Its no-network build smoke test executes that binary,
and application preflight checks the binary before a high-tier review may start
any paid discovery stage.

The current application integration uses this internal Docker boundary for
runtime verification. It enforces the service account's rootless Unix socket,
Docker's reported rootless mode, an immutable local image ID or registry
digest, no container capabilities, and no runtime network. Container UID 0 maps
to the unprivileged `orvex` host account and is used only so that account can
write its own bind-mounted temporary checkout. Dependency installation is
offline-only; missing cached packages skip runtime evidence with an explicit
internal reason rather than blaming the PR or opening egress.

When `ORVEX_CODEX_CONTAINER_RUNTIME=1`, Codex/Luna also runs inside this
boundary. Its container has only the private checkout and the internal broker
network. A service-owned signing key creates a unique, bounded capability for
each container; the OpenAI API key stays mounted only inside the broker. The
broker has the separate egress network, enforces destination, concurrency,
request-count, response-size and timeout bounds, and must be pinned by immutable
local image ID. Keep the explicit repository allowlist as an independent
authorization control.

## Failure Handling

- If `docker-ce-rootless-extras` cannot be installed, stop. Configure Docker's
  official APT repository through the server's normal administration process,
  then re-run `--apply`; do not substitute a random installer script.
- If AppArmor cannot load the scoped profile, stop and inspect the AppArmor
  audit log. Do not turn off AppArmor or change the global user-namespace sysctl.
- If the final `--check` does not report a usable rootless socket, leave
  `ORVEX_CODE_EXECUTION` disabled. The runtime verifier should fail closed,
  rather than falling back to the rootful Docker socket or host execution.
