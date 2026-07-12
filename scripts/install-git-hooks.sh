#!/usr/bin/env bash
set -euo pipefail

if [ "${CI:-}" = "true" ]; then
  echo "Skipping hk hook installation in CI."
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Skipping hk hook installation outside a Git worktree."
  exit 0
fi

if command -v hk >/dev/null 2>&1 && hk --version >/dev/null 2>&1; then
  git config --local --unset-all core.hooksPath || true
  hk install
  exit 0
fi

if command -v mise >/dev/null 2>&1 && hk_path=$(mise where hk 2>/dev/null) && [ -x "$hk_path/hk" ]; then
  git config --local --unset-all core.hooksPath || true
  "$hk_path/hk" install
  exit 0
fi

cat >&2 <<'EOF'
Skipping hk hook installation because neither hk nor mise is available.
Install it with `mise install` or see https://hk.jdx.dev/getting_started.html.
EOF
exit 0
