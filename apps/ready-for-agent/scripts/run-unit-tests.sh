#!/usr/bin/env bash
# Bun for non-Effect suites; Vitest (+ @effect/vitest) for Effect suites.
set -uo pipefail

conditions="@ready-for-agent/source"
effect_ignore=(
  "**/browser-open.test.ts"
  "**/cli.test.ts"
  "**/services/application-config.test.ts"
)

ignore_args=()
for pattern in "${effect_ignore[@]}"; do
  ignore_args+=(--path-ignore-patterns="$pattern")
done

# Real tmux sessions plus direnv/mise activation exceed the 15s default.
# That file skips when the tools are absent.
integration_ignore=(
  --path-ignore-patterns="**/jump-tmux-shell.integration.test.ts"
  --path-ignore-patterns="**/interactive-resume-v2-contract.test.ts"
)

set +e
# Match the 15s default used for ready-for-agent Bun suites on main (host-binary
# smoke can exceed the Bun default under load).
bun --conditions="$conditions" test --timeout=15000 "${ignore_args[@]}" "${integration_ignore[@]}"
code=$?
if [[ "$code" -eq 0 ]]; then
  bun --conditions="$conditions" test --timeout=60000 \
    src/jump-tmux-shell.integration.test.ts
  code=$?
fi
set -e

if [[ "$code" -ne 0 ]]; then
  exit "$code"
fi

bun --bun ./node_modules/vitest/vitest.mjs run --config vitest.config.ts
exit $?
