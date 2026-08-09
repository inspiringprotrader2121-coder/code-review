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

| Command | Privilege | Effect |
| --- | --- | --- |
| `--check` | Any user | Read-only preflight. No package, service, AppArmor, user, Docker, or environment changes. |
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
- Docker's packaged rootless installation must supply the required AppArmor
  policy. If it is absent, provisioning stops. The script never manufactures an
  `unconfined` fallback profile.
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
ORVEX_SANDBOX_IMAGE=registry.example/orvex-runtime@sha256:<64-hex-digest>
```

The production `.env` is immutable by design. Use the existing approved
configuration-management and guarded deployment workflow; do not edit the live
server as a one-off and do not run raw `rsync`.

The current application integration uses this internal Docker boundary for
runtime verification. It enforces the service account's rootless Unix socket,
Docker's reported rootless mode, a digest-pinned local image, no container
capabilities, and no runtime network. Dependency installation is offline-only;
missing cached packages produce honest incomplete evidence rather than opening
egress.

It does **not** yet place the Codex/Luna agent process inside that boundary. Do
not remove the explicit repository allowlist or enable untrusted agentic
execution until the separate credential-isolating Codex runner is implemented,
tested, and deployed.

## Failure Handling

- If `docker-ce-rootless-extras` cannot be installed, stop. Configure Docker's
  official APT repository through the server's normal administration process,
  then re-run `--apply`; do not substitute a random installer script.
- If AppArmor cannot load the scoped profile, stop and inspect the AppArmor
  audit log. Do not turn off AppArmor or change the global user-namespace sysctl.
- If the final `--check` does not report a usable rootless socket, leave
  `ORVEX_CODE_EXECUTION` disabled. The runtime verifier should fail closed,
  rather than falling back to the rootful Docker socket or host execution.
