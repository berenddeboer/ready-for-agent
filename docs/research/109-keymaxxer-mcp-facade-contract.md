# Keymaxxer MCP facade contract

Research for [Specify the Keymaxxer MCP facade contract](https://github.com/berenddeboer/ready-for-agent/issues/109) (map: Design a shared Keymaxxer broker for OpenCode).

Verified against:

| Component | Version / path |
| --- | --- |
| OpenCode CLI | **1.17.18** (mise `opencode`) |
| OpenCode MCP client | Streamable HTTP first, then SSE (`packages/opencode/src/mcp/index.ts` @ `v1.17.18`) |
| Keymaxxer | `/home/berend/src/contrib/keymaxxer` **0.2.0**, stdio only |
| MCP SDK (keymaxxer + workspace) | `@modelcontextprotocol/sdk` **^1.29.0** |

---

## Decision summary

1. **Transport:** MCP **Streamable HTTP** on loopback (required). Optional legacy **SSE** is nice-to-have; OpenCode falls back only if Streamable HTTP fails for non-auth reasons.
2. **Architecture:** **Equivalent-tool facade**, not a transparent JSON-RPC proxy of the upstream stdio session.
3. **Upstream:** Exactly **one** `keymaxxer serve` stdio process remains the sole keyholder (vault key + Allow-session set).
4. **Tools:** Facade advertises the same four MCP tool names, schemas, and text result shapes as Keymaxxer: `keymaxxer_list`, `keymaxxer_add`, `keymaxxer_run`, `keymaxxer_rm`.
5. **HTTP sessions ≠ vault session:** Each client gets its own Streamable HTTP MCP session; all sessions forward tool calls to the single stdio Keymaxxer client.

---

## Why not a transparent MCP message proxy

A transparent proxy would forward every MCP message (including `initialize`, `notifications/*`, and session teardown) between HTTP clients and the stdio Keymaxxer process.

That fails the multi-client goal:

| Problem | Effect |
| --- | --- |
| Stdio transport is one session | Only the first `initialize` is valid; later clients cannot re-initialize the same process |
| Session lifecycle | Client disconnect / `DELETE` would tear down the sole keyholder |
| Framing mismatch | Streamable HTTP uses `mcp-session-id`, SSE event streams, and optional resumability; stdio is line-delimited JSON-RPC |
| Capability negotiation | Each OpenCode process negotiates as client `"opencode"`; the facade must answer as server independently |

**Required shape:** the sidecar is a real MCP **server** toward clients and a single MCP **client** toward Keymaxxer.

```
Harness MCP client ──┐
OpenCode A (remote) ─┼── Streamable HTTP ──► Sidecar McpServer(s)
OpenCode B (remote) ─┘         │
                               │ tools/call only (shared)
                               ▼
                     StdioClientTransport
                               │
                               ▼
                     keymaxxer serve  (sole keyholder)
```

Tool handlers on the facade:

1. Validate HTTP auth (bearer capability — details in the security ticket).
2. `callTool({ name, arguments })` on the shared upstream Client.
3. Return the upstream `CallToolResult` unchanged (content + `isError`).

Do **not** reimplement vault, approval, scrubbing, or dialogs in the facade.

---

## Transport contract (OpenCode 1.17.18)

### Preferred: Streamable HTTP

OpenCode remote connect order:

1. `StreamableHTTPClientTransport` (`@modelcontextprotocol/sdk/client/streamableHttp.js`)
2. `SSEClientTransport` (legacy fallback)

Config fields (no `transport` key):

| Field | Value for Keymaxxer sidecar |
| --- | --- |
| `type` | `"remote"` |
| `url` | Loopback Streamable HTTP endpoint, e.g. `http://127.0.0.1:<port>/mcp` |
| `enabled` | `true` |
| `headers` | `{ "Authorization": "Bearer <capability>" }` |
| `oauth` | `false` (static bearer; do not auto-start OAuth) |
| `timeout` | High enough for unlock/approval dialogs (recommend **≥ 300_000** ms). OpenCode default connect/list timeout is 30s if unset; tool calls also use this timeout with progress reset. |

Example injected via `OPENCODE_CONFIG_CONTENT` (merge, do not clobber other MCP entries):

```json
{
  "mcp": {
    "keymaxxer": {
      "type": "remote",
      "url": "http://127.0.0.1:5032/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer ${SIDECAR_CAPABILITY}"
      },
      "timeout": 300000
    }
  }
}
```

### Server-side Streamable HTTP requirements

Use `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` (or `WebStandardStreamableHTTPServerTransport` on Bun) with **stateful** sessions:

- `sessionIdGenerator: () => crypto.randomUUID()` (or equivalent)
- Map `mcp-session-id` → transport instance (SDK example: `simpleStreamableHttp.js`)
- Accept `POST` (JSON-RPC), `GET` (SSE stream when used), `DELETE` (session end)
- Reject non-initialize requests without a valid session id
- On `DELETE` / transport close: drop **HTTP** session only; **never** close the upstream stdio Keymaxxer client

Optional: `enableJsonResponse: true` for simple request/response clients. OpenCode’s Streamable HTTP client does not require it; prefer default streaming behavior unless a second consumer needs JSON-only.

### SSE

Implement SSE only if a verified consumer needs it. OpenCode will not use SSE when Streamable HTTP succeeds. Do not implement a custom REST facade and expect OpenCode `type: "remote"` to consume it — the current JSON sidecar (`POST /run-with-secrets`, etc.) is **not** MCP and is **not** sufficient for OpenCode.

---

## MCP session model (two layers)

### Layer A — MCP-over-HTTP client sessions

| Property | Contract |
| --- | --- |
| Scope | One session per connecting MCP client process (Harness, each OpenCode) |
| Identity | Server-generated `mcp-session-id` |
| Initialize | Per HTTP session; facade answers as server name e.g. `keymaxxer-sidecar` |
| tools/list | Returns the four Keymaxxer tools (static; no list_changed required unless tools become dynamic) |
| tools/call | Forwarded to upstream stdio client |
| Disconnect | Ends Layer A only |

### Layer B — vault / approval session (upstream Keymaxxer process)

Unchanged from Keymaxxer `serve()` semantics (`packages/cli/src/mcp.ts`):

| Property | Contract |
| --- | --- |
| Scope | Lifetime of the single stdio `keymaxxer serve` child |
| Unlock | Lazy on first tool that needs the vault; passphrase/GUI once per process |
| Allow session | `approved: Set<string>` in that process; shared across all Layer A clients |
| Allow once / deny | Per `keymaxxer_run` call; once does not enter the set |
| Idle re-lock | `KEYMAXXER_IDLE_MINUTES` if set; clears store + approved set for **all** clients |
| Secret values | Never appear in any tool result; only in child env of `keymaxxer_run` |

**Invariant:** N OpenCode processes + Harness share **one** Layer B session.

---

## Tool discovery and names

### Upstream MCP names (protocol)

Register on the facade exactly as Keymaxxer does:

| Name | Input | Result |
| --- | --- | --- |
| `keymaxxer_list` | `{}` | Text JSON array of secret metadata (no values) |
| `keymaxxer_run` | `command`, `secrets[]`, optional `cwd`, `timeoutMs` | Text: `exit_code`, optional redaction line, stdout/stderr; `isError` if exit ≠ 0 |
| `keymaxxer_add` | `name` + optional attrs | Text confirmation or cancel message; value never returned |
| `keymaxxer_rm` | `name` | Text removed / not found |

Descriptions and Zod/JSON schemas should match Keymaxxer so agents and the Harness `mcpKeymaxxerLayer` keep calling the same names.

### OpenCode LLM-facing IDs

OpenCode prefixes every tool: `sanitize(configKey) + "_" + sanitize(mcpToolName)` (`McpCatalog.toolName`).

With config key `keymaxxer` and MCP names `keymaxxer_*`, the LLM sees:

- `keymaxxer_keymaxxer_list`
- `keymaxxer_keymaxxer_run`
- `keymaxxer_keymaxxer_add`
- `keymaxxer_keymaxxer_rm`

That matches **current** local stdio OpenCode wiring on this machine (global `mcp.keymaxxer` → same double prefix). Do **not** rename MCP tools to unprefixed `list`/`run` without a separate Harness migration: `packages/keymaxxer-service` calls `keymaxxer_list` / `keymaxxer_run` / `keymaxxer_add` by protocol name.

Call path: LLM id is local to OpenCode; the remote `tools/call` uses the **original** MCP name (`keymaxxer_run`), which is what the facade must accept and forward.

---

## Result shape (passthrough)

Upstream and facade return only MCP text content (no resources/prompts/images required):

```ts
{
  content: [{ type: "text", text: string }],
  isError?: true
}
```

Facade must not parse or rewrite success payloads except for logging metadata (never log secret-bearing command output beyond what Keymaxxer already scrubbed).

Error text form from Keymaxxer: `error: <message>` with `isError: true`.

---

## Forwarding architecture (implementation sketch)

```
Sidecar process
├── HTTP listener (loopback only)
│   ├── auth middleware (bearer; reject Origin — security ticket)
│   └── /mcp → StreamableHTTPServerTransport per session
│         └── McpServer.registerTool(keymaxxer_*) → forward
└── Shared upstream (lazy, once)
    └── Client + StdioClientTransport → keymaxxer serve
        (KEYMAXXER_ENTRYPOINT, then keymaxxer on PATH)
```

Concurrency notes (detail belongs in multi-client concurrency research):

- Serialize or carefully gate unlock/approval-sensitive calls so dialogs do not race.
- Long-running `keymaxxer_run` must not block unrelated `keymaxxer_list` if the SDK allows concurrent tool calls on one Client; if not, document a single-flight queue.
- HTTP session teardown must not abort in-flight upstream runs belonging to other sessions unless the whole sidecar shuts down.

---

## Compatibility matrix

| Consumer | How it connects | Works with this contract? |
| --- | --- | --- |
| OpenCode 1.17.18 remote MCP | Streamable HTTP + bearer headers, `oauth: false` | **Yes** |
| OpenCode local stdio Keymaxxer | Spawns its own keymaxxer | **Disable** when harness-spawned (`enabled: false` or replace with remote) |
| Harness `mcpKeymaxxerLayer` | Stdio client today | Keep as upstream **inside** sidecar; replace Harness direct stdio with either HTTP MCP client or domain service over the same facade |
| Current JSON sidecar (`/run-with-secrets`) | Custom REST | **Not** OpenCode-compatible; retire or keep only as internal Harness adapter, not as the OpenCode surface |

---

## Explicitly rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Transparent JSON-RPC proxy onto one stdio session | Breaks multi-client initialize/session lifecycle |
| Custom REST as OpenCode `type: "remote"` | OpenCode requires real MCP Streamable HTTP or SSE |
| One stdio Keymaxxer per OpenCode process | Reintroduces repeated unlock/approval; violates destination |
| Putting vault key in the Harness or OpenCode process | Violates secret boundary |
| OAuth for loopback sidecar | Unnecessary; static bearer capability is the planned auth model |
| Renaming tools for prettier OpenCode IDs in this ticket | Optional later; would break Harness tool names without a migration |

---

## OpenCode config contract for launch tickets

When the Harness spawns OpenCode, it must inject remote Keymaxxer MCP and ensure no second local Keymaxxer is started:

1. Set `mcp.keymaxxer` to the remote shape above (url + bearer + `oauth: false` + long timeout).
2. Do **not** leave a local `command: […, "serve"]` entry enabled for the same logical server.
3. Merge with existing `OPENCODE_CONFIG_CONTENT` (deep-merge `mcp`, overwrite only the `keymaxxer` entry).
4. Do not put secret values into OpenCode env; only the bearer capability for the MCP endpoint.

---

## Sources

- Keymaxxer MCP: `/home/berend/src/contrib/keymaxxer/packages/cli/src/mcp.ts`
- OpenCode remote MCP: `https://github.com/anomalyco/opencode/blob/v1.17.18/packages/opencode/src/mcp/index.ts`
- OpenCode tool naming: `…/packages/opencode/src/mcp/catalog.ts` (`toolName`, `sanitize`)
- OpenCode docs: `https://opencode.ai/docs/mcp-servers/`
- MCP SDK Streamable HTTP server: `@modelcontextprotocol/sdk` `server/streamableHttp.js`, example `examples/server/simpleStreamableHttp.js`
- Current harness sidecar (non-MCP HTTP): `docs/adr/0004-development-keymaxxer-sidecar.md`, `packages/keymaxxer-service`
