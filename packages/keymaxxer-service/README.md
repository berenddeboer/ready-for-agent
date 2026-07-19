# Keymaxxer Service

Reusable Effect boundary for Keymaxxer vault operations. `KeymaxxerService`
supports initializing the session, checking whether a named secret exists,
opening Keymaxxer's add-secret flow, and running a command with named secrets
injected. Secret deletion is a Keymaxxer CLI operation (`keymaxxer rm`), not part
of this boundary.

The boundary never returns raw secret values. `runWithSecrets` returns only the
exit code and separate stdout and stderr streams. A non-zero exit is a command
result; transport, protocol, and execution failures use `KeymaxxerError`.

## Layers

- `startKeymaxxerFacade()` — Streamable HTTP MCP facade used by
  `apps/keymaxxer-sidecar` (one stdio keyholder; path capability auth).
- `sidecarKeymaxxerLayer(url)` — Harness MCP client for a capability URL
  `http://127.0.0.1:<port>/<capability>/mcp`.
- `mcpKeymaxxerLayer()` — lazy stdio MCP client (tests / direct keyholder).
- `testKeymaxxerLayer(secretNames)` — in-memory implementation for tests.

## Commands

- `bunx nx run keymaxxer-service:build`
- `bunx nx run keymaxxer-service:test`
- `bunx nx run keymaxxer-service:typecheck`
