# Keymaxxer Service

Reusable Effect boundary for Keymaxxer vault operations. `KeymaxxerService`
supports initializing the session, checking whether a named secret exists,
opening Keymaxxer's add-secret flow, and running a command with named secrets
injected. Secret deletion is a Keymaxxer CLI operation (`keymaxxer rm`), not part
of this boundary.

The boundary never returns raw secret values. `runWithSecrets` returns only the
exit code and separate stdout and stderr streams. A non-zero exit is a command
result; transport, protocol, and execution failures use `KeymaxxerError`.

## Layers and process boundaries

**Effect-native client API** (Harness / OpenCode consumers):

- `sidecarKeymaxxerLayer(url)` — MCP client for a capability URL
  `http://127.0.0.1:<port>/<capability>/mcp`. Methods are `Effect.fn` / `Effect.gen`;
  `tryPromise` only at MCP SDK connect/callTool.
- `mcpKeymaxxerLayer()` — lazy stdio MCP client (tests / direct keyholder).
- `testKeymaxxerLayer(secretNames)` — in-memory implementation for tests.
- `disabledKeymaxxerLayer` — ambient-env command runner when Keymaxxer is off
  (Promise `child_process` shim by design).

**Promise-first process boundary** (not an Effect service):

- `startKeymaxxerFacade()` — Streamable HTTP MCP facade used by
  `apps/keymaxxer-sidecar` (one stdio keyholder; path capability auth).
  Before the first `keymaxxer_run` / `keymaxxer_add`, it runs a serialized
  `keymaxxer_list` unlock probe (wrong passphrase retried up to three times).
  Once unlocked, metadata-only `keymaxxer_list` may proceed while a dialog
  operation waits for secret-use approval. Side-effecting failures are not
  replayed; transport failures invalidate the upstream for the next request.
  Harness→sidecar and sidecar→keyholder MCP tool calls use an explicit
  human-dialog timeout of at least `KEYMAXXER_HUMAN_DIALOG_TIMEOUT_MS` (300s);
  `keymaxxer_run` adds the declared child `timeoutMs` to that budget while the
  child still enforces `timeoutMs` independently. Cancelled callers that have
  not yet acquired the global dialog lane are removed and never invoke upstream;
  an already-forwarded operation is not replayed and does not clear shared vault
  approvals. Operator logs distinguish dialog-lane queue wait, execution failure,
  and timeout without logging secret names, values, command output, or capability
  URLs. Dialog-capable ops still share one serialized dialog lane (concurrent
  already-approved runs are not implemented yet; many GitHub helper calls queue
  on that lane).
- `runKeymaxxerSidecarProcess()` — sidecar process body (listen, bootstrap URL,
  signals). Uses zod only for MCP SDK tool `inputSchema` registration; Effect
  client payloads use Schema.

## Validation

- Effect client: branded `SecretName` Schema and Schema decode for tool payloads.
- Facade/MCP server registration: zod (required by the MCP SDK). One stack per
  boundary — no dual validation of the same payload.

## Commands

- `bunx nx run keymaxxer-service:build`
- `bunx nx run keymaxxer-service:test`
- `bunx nx run keymaxxer-service:typecheck`
