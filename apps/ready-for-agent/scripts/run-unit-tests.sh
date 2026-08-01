#!/usr/bin/env bash
# Bun for non-Effect suites; Vitest (+ @effect/vitest) for Effect suites.
set -uo pipefail

conditions="@ready-for-agent/source"
effect_ignore=(
  "**/cli.test.ts"
  "**/services/application-config.test.ts"
)

ignore_args=()
for pattern in "${effect_ignore[@]}"; do
  ignore_args+=(--path-ignore-patterns="$pattern")
done

set +e
# Match the 15s default used for ready-for-agent Bun suites on main (host-binary
# smoke can exceed the Bun default under load).
bun --conditions="$conditions" test --timeout=15000 "${ignore_args[@]}"
code=$?
set -e

if [[ "$code" -ne 0 ]]; then
  exit "$code"
fi

bun --bun ./node_modules/vitest/vitest.mjs run --config vitest.config.ts
exit $?
