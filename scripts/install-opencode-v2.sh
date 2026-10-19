#!/usr/bin/env bash
# Install the OpenCode 2 CLI used by opencode:cli-contract.
# baseline: mise.toml OPENCODE_V2_BASELINE (required PR and main coverage).
# latest: @opencode/cli latest stable (scheduled drift coverage only).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-baseline}"

read_baseline() {
  sed -n 's/^OPENCODE_V2_BASELINE = "\([^"]*\)"/\1/p' "$root/mise.toml"
}

resolve_latest() {
  curl -fsSL https://registry.npmjs.org/@opencode/cli/latest \
    | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p'
}

case "$mode" in
  baseline) version="$(read_baseline)" ;;
  latest) version="$(resolve_latest)" ;;
  *)
    echo "usage: install-opencode-v2.sh baseline|latest" >&2
    exit 2
    ;;
esac

if [[ -z "$version" ]]; then
  echo "OpenCode install failed: could not resolve a version for mode ${mode}." >&2
  exit 1
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "OpenCode install failed: '${version}' is not major.minor.patch." >&2
  exit 1
fi

echo "[opencode-install] mode=${mode} version=${version}"

if [[ "${OPENCODE_INSTALL_DRY_RUN:-}" == "1" ]]; then
  exit 0
fi

curl -fsSL https://opencode.ai/v2/install | bash -s -- --version "$version" --no-modify-path

binary="${HOME}/.opencode/bin/opencode"
if [[ ! -x "$binary" ]]; then
  echo "OpenCode install failed: ${binary} is missing after the installer exited." >&2
  exit 1
fi

resolved="$("$binary" --version 2>&1 || true)"
echo "[opencode-install] binary=${binary} version=${resolved}"
if [[ "$resolved" != *"$version"* ]]; then
  echo "OpenCode install failed: requested ${version}, installer produced: ${resolved}" >&2
  exit 1
fi
