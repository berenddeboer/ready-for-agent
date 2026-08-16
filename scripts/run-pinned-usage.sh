#!/usr/bin/env bash
# Invoke the workspace-pinned Usage CLI without relying on an untrusted mise shim.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
expected="$(sed -n 's/^usage = "\([^"]*\)"/\1/p' "${root}/mise.toml")"
if [[ -z "${expected}" ]]; then
  echo "error: no usage pin in ${root}/mise.toml" >&2
  exit 1
fi

try_bin() {
  local bin=$1
  shift
  if [[ ! -x "${bin}" ]]; then
    return 1
  fi
  local ver
  ver="$("${bin}" --version 2>/dev/null || true)"
  ver="${ver//$'\r'/}"
  ver="${ver%%$'\n'*}"
  if [[ "${ver}" == "usage-cli ${expected}" ]]; then
    exec "${bin}" "$@"
  fi
  return 1
}

if [[ -n "${USAGE_BIN:-}" ]]; then
  try_bin "${USAGE_BIN}" "$@" || {
    echo "error: USAGE_BIN is not Usage ${expected}" >&2
    exit 1
  }
fi

if [[ -n "${HOME:-}" ]]; then
  try_bin "${HOME}/.local/share/mise/installs/usage/${expected}/usage" "$@" || true
fi

if command -v usage >/dev/null 2>&1; then
  try_bin "$(command -v usage)" "$@" || true
fi

echo "error: Usage CLI ${expected} is required (see mise.toml). Install with: mise install" >&2
exit 1
