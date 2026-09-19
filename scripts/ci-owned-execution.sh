#!/usr/bin/env bash
# GitHub runners execute outside the user's delegated cgroup hierarchy. Start
# tests inside a user service so their children can enter invocation cgroups.
# Preserve CI's environment in a private file, not in process arguments or the
# user manager's global environment.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  printf '%s\n' 'This setup helper is only for GitHub Actions runners.' >&2
  exit 1
fi

runner_uid="$(id -u)"
sudo systemctl start "user@${runner_uid}.service"
export XDG_RUNTIME_DIR="/run/user/${runner_uid}"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
systemctl --user show --property=Version
test -f /sys/fs/cgroup/cgroup.controllers

umask 077
ci_environment_file="$(mktemp)"
trap 'rm -f "$ci_environment_file"' EXIT
python3 - > "$ci_environment_file" <<'PY'
import os
import re
for name, value in os.environ.items():
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        print(f'{name}="{escaped}"')
PY
systemd-run --user --quiet --collect --wait --pipe --service-type=exec \
  --expand-environment=no --working-directory="$PWD" \
  --property="EnvironmentFile=${ci_environment_file}" -- "$@"
