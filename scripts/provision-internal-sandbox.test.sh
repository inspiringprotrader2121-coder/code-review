#!/usr/bin/env bash
# Static/non-privileged checks for the administrator sandbox workflow.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/provision-internal-sandbox.sh"

bash -n "$SCRIPT"
"$SCRIPT" --help >/dev/null

if "$SCRIPT" --not-a-real-flag >/dev/null 2>&1; then
  printf 'expected unknown-argument failure\n' >&2
  exit 1
fi

# The workflow must keep Ubuntu's global user-namespace defense in place and
# must never encourage a global AppArmor bypass.
if rg -n 'apparmor_restrict_unprivileged_userns=0|apparmor=0|aa-disable|systemctl (stop|disable) apparmor' "$SCRIPT"; then
  printf 'unsafe global AppArmor weakening found\n' >&2
  exit 1
fi
rg -q 'MODE="check"' "$SCRIPT"
rg -q '\[\[ \$\(id -u\) -eq 0 \]\]' "$SCRIPT"
rg -q 'require_host_security_baseline' "$SCRIPT"
rg -q 'docker-ce-rootless-extras' "$SCRIPT"
if rg -n 'flags=\(unconfined\)|userns,' "$SCRIPT"; then
  printf 'unsafe custom unconfined AppArmor fallback found\n' >&2
  exit 1
fi
rg -q 'require_packaged_apparmor_profile' "$SCRIPT"
rg -q 'dpkg-query -S' "$SCRIPT"
rg -q 'apparmor_parser -Q' "$SCRIPT"
rg -q 'DOCKER_HOST="unix://\$RUNTIME_DIR/docker.sock"' "$SCRIPT"

printf 'provision-internal-sandbox static tests passed\n'
