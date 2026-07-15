# Shared broker security model

Resolution of [Define the shared broker security model](https://github.com/berenddeboer/ready-for-agent/issues/113) (part of [Design a shared Keymaxxer broker for OpenCode](https://github.com/berenddeboer/ready-for-agent/issues/106)).

Depends on:

- [Specify the Keymaxxer MCP facade contract](https://github.com/berenddeboer/ready-for-agent/issues/109) — Streamable HTTP facade; remote MCP client shape
- [Define sidecar and vault session lifecycles](https://github.com/berenddeboer/ready-for-agent/issues/111) — fixed loopback port; TCP readiness; new capability on sidecar restart

Revises #109’s sketch of `Authorization: Bearer <capability>`: v1 uses an **unguessable URL path** as the sole client secret (no Bearer header).

---

## Goal

Define the threat model and concrete access-control contract for the loopback MCP endpoint so Harness and every spawned OpenCode process can use one shared Keymaxxer Sidecar without ambient loopback trust, without capability files, and without claiming defenses Keymaxxer cannot provide.

---

## Threat model

### Defend against

1. **Browsers** — pages that can reach `127.0.0.1` (Origin / CORS path; same spirit as ADR-0004)
2. **Unauthenticated local clients** — processes that know the fixed port but not the capability (scanners, random tools, misconfigured agents)
3. **Ambient loopback trust** — “anything on loopback may call vault operations once unlocked”

### Explicitly do not claim

- Another process as the **same OS user** that can read sidecar/keyholder memory, Harness/OpenCode env, or process listings that expose the capability URL
- A compromised Harness or OpenCode process that already holds a valid capability URL
- Off-host / remote attackers (loopback-only; multi-host Keymaxxer remains out of scope per #106)

Same-user memory inspection is irreducible without OS-level isolation; Keymaxxer’s own threat model states this. Stronger isolation (separate OS user, sandbox) composes cleanly but is not part of this broker contract.

---

## Capability: unguessable path (not Bearer)

| Decision | Choice |
| --- | --- |
| Secret form | Opaque path segment in the MCP URL |
| Bearer header | **Not used** in v1 |
| Capability files | **None** — do not write the secret to disk |
| Entropy | 32 bytes CSPRNG |
| Encoding | base64url, no padding (~43 characters) |
| Lifetime | One generation per sidecar process listen; no mid-life rotation |
| Independence | Not derived from vault passphrase or master key |

### URL shape

```text
http://127.0.0.1:<port>/<capability>/mcp
```

- Port: fixed loopback default `5032` / `KEYMAXXER_SIDECAR_PORT` (per #111)
- Host: `127.0.0.1` only
- MCP Streamable HTTP lives only under `/<capability>/mcp`

### Auth checks (order)

1. If request has an `Origin` header → **403** (`browser requests are forbidden` or equivalent); no CORS headers ever
2. If path capability segment missing or not equal (constant-time compare) → **404** minimal body
3. Otherwise proceed with MCP handling

Never use **401** or `WWW-Authenticate` (wrong model for path capability; noisy oracle for scanners).

### What is not exposed

- **No** fixed unauthenticated `/health` (or any other unauthenticated route)
- Readiness remains **TCP listen only** (#111); Harness ~5s TCP gate does not need the capability
- **No** unauthenticated REST operation API. When the MCP facade ships, drop the legacy JSON REST surface or place any temporary migration routes under `/<capability>/…` with the same Origin rules — prefer drop

---

## Generation, rotation, delivery

### Generation

On successful bind/listen, the sidecar:

1. Generates `<capability>` in memory
2. Serves MCP only under `/<capability>/mcp`
3. Emits **one** bootstrap line on stdout (sole intentional full-URL emission):

```text
KEYMAXXER_SIDECAR_URL=http://127.0.0.1:<port>/<capability>/mcp
```

### Rotation

- Capability changes only when the **sidecar process** restarts (Nx restart, crash, hard stop)
- Aligns with #111: sidecar restart → new vault session + new capability
- No idle-linked path rotation, no manual rotate API in v1
- In-flight clients with the old URL fail until Harness re-captures stdout / reconfigures

### Delivery (no files)

| Consumer | How it gets the URL |
| --- | --- |
| **Harness** | Captures sidecar stdout bootstrap line; holds `KEYMAXXER_SIDECAR_URL` **in memory only** |
| **OpenCode** | Harness injects into `OPENCODE_CONFIG_CONTENT` when spawning: `mcp.keymaxxer = { type: "remote", url: <full capability URL>, enabled: true, oauth: false, timeout: ≥ 300000 }` — no Bearer headers, no separate secret env var |

Nx may still set port-related env for the sidecar process; the **secret path is not** pre-shared via env files or disk.

---

## Logging and storage constraints

- After bootstrap capture, treat the full URL (and path segment) as a **secret**
- Logs/metrics may show **host:port only** (e.g. `listening on 127.0.0.1:5032`)
- Redact path segments that match the live capability in any access/error/crash logging
- Never put the capability in error response bodies
- Do not persist the capability to disk, git, or durable config
- Facade must not log secret-bearing command output beyond what Keymaxxer already scrubbed (#109)

Accepted leak class under the threat model: same-UID readers of process env / `OPENCODE_CONFIG_CONTENT` / sidecar memory.

---

## OpenCode remote config (security half of #112)

```json
{
  "mcp": {
    "keymaxxer": {
      "type": "remote",
      "url": "http://127.0.0.1:5032/<capability>/mcp",
      "enabled": true,
      "oauth": false,
      "timeout": 300000
    }
  }
}
```

No `headers.Authorization`. Local stdio `keymaxxer` command config for the same server must remain disabled so OpenCode does not spawn a second keyholder.

---

## Relationship to prior ADRs / tickets

| Source | Effect |
| --- | --- |
| ADR-0004 Origin + JSON browser rejection | **Kept** Origin rejection; extended to MCP path; Content-Type-as-browser-guard is secondary once path + Origin are required |
| ADR-0004 no remote auth | **Kept** — still loopback-only; path capability is local client auth, not remote multi-tenant auth |
| #109 Bearer sketch | **Revised** — opaque path only |
| #111 “new bearer on restart” | **Kept** as new path capability on sidecar restart |
| Keymaxxer scrubbing / no raw values to agents | Unchanged; out of scope for this ticket’s HTTP surface |

---

## Out of scope

- Unix domain sockets or SO_PEERCRED
- Running keyholder as a separate OS user
- OAuth / remote multi-user auth
- Mid-session capability rotation without process restart
- Capability files under `$XDG_RUNTIME_DIR` or similar

---

## Acceptance checklist (for implementers / #114)

- [ ] Sidecar binds `127.0.0.1` only; MCP only at `/<cap>/mcp`
- [ ] Capability is 32-byte CSPRNG base64url; generated once per listen
- [ ] Stdout bootstrap line once; no capability files
- [ ] Origin → 403; wrong path → 404; no `/health`
- [ ] Logs never contain full capability URL after bootstrap
- [ ] Harness memory-only URL; OpenCode remote config injects URL without Bearer
- [ ] Sidecar restart invalidates old URL and vault session
