# Keymaxxer Service

Reusable Effect boundary for Keymaxxer vault operations. `KeymaxxerService`
supports initializing the session, checking whether a named secret exists,
opening Keymaxxer's add-secret flow, and running a command with named secrets
injected.

The boundary never returns raw secret values. `runWithSecrets` returns only the
exit code and separate stdout and stderr streams. A non-zero exit is a command
result; transport, protocol, and execution failures use `KeymaxxerError`.

## Layers

- `mcpKeymaxxerLayer()` owns a lazy, scoped stdio MCP client. It is used by
  production processes and by the development sidecar.
- `sidecarKeymaxxerLayer(url)` is the strict loopback HTTP client used by the
  watched API. It accepts only `http://127.0.0.1:<port>`.
- `testKeymaxxerLayer(secretNames)` is an in-memory implementation for tests.

The HTTP protocol uses shared Effect schemas, rejects unknown fields and raw
secret-shaped response fields, blocks browser-originated and non-JSON operation
requests, and versions its non-initializing `/health` response. Sidecar
connection refusal is retried for at most five seconds during startup; hanging
health requests share that deadline, and HTTP and protocol failures are not
retried.

## Commands

- `bunx nx run keymaxxer-service:build`
- `bunx nx run keymaxxer-service:test`
- `bunx nx run keymaxxer-service:typecheck`
