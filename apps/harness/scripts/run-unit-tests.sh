#!/usr/bin/env bash
# Default Harness unit suite: parallel + exclude production SSE idle-timeout.
# Bun 1.3.x can SIGILL-crash isolate workers under --parallel; retry without
# workers so CI on stable Bun still gates the suite.
set -uo pipefail

conditions="@ready-for-agent/source"
ignore="**/production-sse-idle-timeout.test.ts"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

set +e
bun --conditions="$conditions" test --parallel --path-ignore-patterns="$ignore" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e

if [[ "$code" -eq 0 ]]; then
  exit 0
fi

if grep -Eqi 'worker crashed|SIGILL|Segmentation fault' "$log"; then
  echo "warning: bun test --parallel crashed (Bun isolate worker bug); retrying without --parallel" >&2
  bun --conditions="$conditions" test --path-ignore-patterns="$ignore"
  exit $?
fi

exit "$code"
