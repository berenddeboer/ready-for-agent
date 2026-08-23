#!/usr/bin/env bash
# Default Harness unit suite:
# - Bun for non-Effect suites (parallel; retry without workers on Bun isolate crash)
# - Vitest for Effect suites that use @effect/vitest
set -uo pipefail

# Non-interactive by default: ordinary unit tests never need operator
# credentials and must never trigger a Keymaxxer unlock/approval prompt, even
# when this runner is invoked directly (bypassing the Nx target env). Live
# e2e is the only Keymaxxer-enabled test suite; it runs through Playwright,
# not this script.
export KEYMAXXER_ENABLED=false

conditions="@ready-for-agent/source"
# Migrated Effect suites run under vitest; keep them out of bun test.
effect_ignore=(
  "**/job-worker.test.ts"
  "**/keymaxxer-github-layer.test.ts"
  "**/keymaxxer-gitlab-layer.test.ts"
  "**/ambient-github-layer.test.ts"
  "**/ambient-gitlab-layer.test.ts"
  "**/application-config.test.ts"
  "**/application-runtime-disposal.test.ts"
  "**/production-sse-idle-timeout.test.ts"
)
# Also exclude the slow SSE suite from the default bun path (historical)
# and the Keymaxxer uninitialized live e2e (must not inherit this runner's
# KEYMAXXER_ENABLED=false; run via harness:e2e-no-vault).
bun_ignore=(
  "**/production-sse-idle-timeout.test.ts"
  "**/keymaxxer-uninitialized-e2e.test.ts"
  "${effect_ignore[@]}"
)

ignore_args=()
for pattern in "${bun_ignore[@]}"; do
  ignore_args+=(--path-ignore-patterns="$pattern")
done

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

set +e
bun --conditions="$conditions" test --parallel "${ignore_args[@]}" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e

if [[ "$code" -ne 0 ]]; then
  if grep -Eqi 'worker crashed|SIGILL|Segmentation fault' "$log"; then
    echo "warning: bun test --parallel crashed (Bun isolate worker bug); retrying without --parallel" >&2
    bun --conditions="$conditions" test "${ignore_args[@]}"
    code=$?
  fi
fi

if [[ "$code" -ne 0 ]]; then
  exit "$code"
fi

# Effect suites (vitest + @effect/vitest). Run under Bun so packages that use
# `bun:*` builtins (sqlite, etc.) resolve. Exclude the intentionally slow SSE
# suite from the default gate — still available via `nx run harness:slow-test`.
bun --bun ./node_modules/vitest/vitest.mjs run \
  --config vitest.config.ts \
  --exclude '**/production-sse-idle-timeout.test.ts'
exit $?
