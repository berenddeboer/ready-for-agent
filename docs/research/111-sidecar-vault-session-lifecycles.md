# Sidecar and vault session lifecycles

Resolution of [Define sidecar and vault session lifecycles](https://github.com/berenddeboer/ready-for-agent/issues/111) (part of [Design a shared Keymaxxer broker for OpenCode](https://github.com/berenddeboer/ready-for-agent/issues/106)).

Depends on:

- [Specify the Keymaxxer MCP facade contract](https://github.com/berenddeboer/ready-for-agent/issues/109) — Streamable HTTP facade; one stdio keyholder; Layer A HTTP sessions vs Layer B vault session
- [Determine safe multi-client broker concurrency](https://github.com/berenddeboer/ready-for-agent/issues/110) — disconnect is Layer A only; Allow-session stays in upstream Keymaxxer

---

## Goal

Define process ownership, startup, readiness, shutdown, crash-recovery, idle-lock, and restart semantics so:

1. Vault unlock happens **once per broker (vault) session**
2. A secret granted with **Allow session** remains approved for **all** clients exactly until that vault session locks or ends

---

## Two session layers (unchanged from #109)

| Layer | What | Lifetime |
| --- | --- | --- |
| **A — HTTP MCP session** | One per Harness / OpenCode client | Client connection; disconnect ends only this layer |
| **B — Vault / approval session** | One upstream `keymaxxer serve` process | Keyholder process life, or Keymaxxer idle re-lock |

Allow-session is Layer B only (`approved` set inside Keymaxxer). It is shared across all Layer A clients attached to the same sidecar.

---

## Process ownership

| Actor | Role |
| --- | --- |
| **Nx continuous target** | Starts and restarts the sidecar process (this stage only; no systemd/container contract yet) |
| **Keymaxxer Sidecar** | Owns loopback MCP server; sole parent of one `keymaxxer serve` stdio child |
| **Harness / OpenCode** | MCP **clients only**; never spawn Keymaxxer stdio; never own vault session |

Production packaging/supervision is deferred. The process model is the same long-lived sidecar + one keyholder (not Harness in-process). When implemented, this supersedes ADR-0004’s “production in-process” topology.

---

## Broker / vault session boundary

**One vault session = lifetime of one `keymaxxer serve` child.**

Starts when the sidecar first spawns that child. Ends when any of:

- Sidecar hard stop (SIGINT/SIGTERM / Nx stop)
- Keyholder process exit (crash → later respawn is a **new** session)
- Keymaxxer idle re-lock (`KEYMAXXER_IDLE_MINUTES` > 0: store closed, `approved` cleared)

A new keyholder process is always a new vault session: re-unlock and re-approve.

---

## Startup sequence

1. **Sidecar process starts** (Nx) → bind fixed loopback port → MCP listen.
2. **Upstream `keymaxxer serve`** — spawn **lazily, once**, on first client need that requires the keyholder (not at listen time).
3. **Vault unlock** — remains lazy **inside** Keymaxxer on first tool that needs the vault (one passphrase dialog for the whole vault session).

No unlock prompt at sidecar boot.

---

## Readiness

**Ready = TCP listen** on the configured loopback MCP port.

Not required for readiness:

- Keyholder spawned
- Vault unlocked

### Port

- Default `5032`, overridable with `KEYMAXXER_SIDECAR_PORT`
- Clients use `KEYMAXXER_SIDECAR_URL` (set by Nx for Harness)
- Bind conflict → **fail fast** with a clear override message (no dynamic port, no discovery file)
- Harness passes the same URL into OpenCode remote MCP config when spawning OpenCode (see launch-contract ticket)

### Harness startup gate

When a sidecar URL is configured:

- Harness must reach TCP listen before serving
- Short retry (~5s) for Nx process-start race
- After the sidecar responds, protocol/init failures fail immediately
- **No** in-process Keymaxxer fallback (would restore repeated unlock/approval prompts on reload)

---

## Shutdown

On SIGINT/SIGTERM (Nx stop, Ctrl-C, `harness:dev` teardown):

1. Stop accepting new HTTP MCP sessions
2. Abort in-flight client requests
3. Close/kill upstream `keymaxxer serve` (wipes key + Allow-session)
4. Exit

**Hard stop** — no multi-second graceful drain. In-flight `keymaxxer_run` children die with the keyholder.

---

## Crash recovery

### Keyholder dies, sidecar lives

1. Detect child exit
2. Fail in-flight tools cleanly to their Layer A clients
3. On next need, spawn a **fresh** `keymaxxer serve`
4. New vault session → re-unlock + re-approve

Never pretend Allow-session still holds across keyholder death.

### Sidecar process dies

1. Nx continuous target restarts the sidecar
2. Fresh process → new vault session
3. New bearer capability when security model is applied (security ticket)
4. Clients must reconnect; unlock/approvals again
5. No persistence of unlock or approvals across sidecar crashes

---

## Idle re-lock

- Policy is **Keymaxxer’s**: `KEYMAXXER_IDLE_MINUTES` (0 / unset = off; vault stays unlocked for the keyholder’s life)
- Sidecar **passes through** the env; does **not** invent a second idle policy
- Idle re-lock ends the vault session for **all** clients (`store` closed, `approved` cleared)
- Next tool call **transparently** re-prompts unlock (and approval if needed) — no facade `session_expired` protocol
- Client MCP timeout remains ≥ 300s for dialogs (#109)
- Known upstream gap: idle timer may clear the store during an in-flight run; v1 documents this and does not add facade refcount. Optional Keymaxxer follow-up already noted in #110.

---

## Allow session semantics (product)

| Grant | Scope | Ends when |
| --- | --- | --- |
| **Allow session** | Secret name, all Layer A clients on this sidecar | Vault session ends (idle lock, keyholder death, sidecar hard stop) |
| **Allow once** | Single `keymaxxer_run` | That call finishes |
| **Deny** | That call (coalesced waiters may share deny per #110) | Immediate |

Facade does not reimplement the `approved` set (#109/#110).

---

## Explicit non-goals (this ticket)

- Production supervisor (systemd, k8s sidecar, etc.) — deferred
- Dynamic port / discovery file
- Facade-owned idle policy or refcounted idle
- Bearer generation, rotation, logging — security ticket
- OpenCode spawn/env merge details — launch-contract ticket
- Changing Keymaxxer Allow-session product meaning

---

## Implications for prototype (#114)

Must demonstrate:

1. Sidecar listen without unlock; first multi-client use → one passphrase
2. Allow session on secret S → second OpenCode client uses S without re-prompt until session ends
3. Kill one OpenCode mid-flight → vault session remains for the other
4. Kill keyholder (or restart sidecar) → next use re-prompts unlock and approval
5. Hard stop of sidecar clears session (no orphan keyholder)

---

## ADR impact

When this design is implemented, **ADR-0004 (development-only sidecar; production in-process)** is superseded for topology: one long-lived sidecar owns the vault session in the target architecture; dev is started via Nx now; prod packaging follows later under the same process model.

---

## Sources

- Keymaxxer MCP session / idle: `/home/berend/src/contrib/keymaxxer/packages/cli/src/mcp.ts`
- Current sidecar: `apps/keymaxxer-sidecar`, `docs/adr/0004-development-keymaxxer-sidecar.md`
- Facade + concurrency: `docs/research/109-keymaxxer-mcp-facade-contract.md`, `docs/research/110-multi-client-broker-concurrency.md`
