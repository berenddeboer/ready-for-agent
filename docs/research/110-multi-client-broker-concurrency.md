# Safe multi-client broker concurrency

Research for [Determine safe multi-client broker concurrency](https://github.com/berenddeboer/ready-for-agent/issues/110) (map: Design a shared Keymaxxer broker for OpenCode).

Builds on [Specify the Keymaxxer MCP facade contract](https://github.com/berenddeboer/ready-for-agent/issues/109) / [`docs/research/109-keymaxxer-mcp-facade-contract.md`](./109-keymaxxer-mcp-facade-contract.md).

Verified against:

| Component | Version / path |
| --- | --- |
| OpenCode CLI | **1.17.18** |
| OpenCode MCP | Streamable HTTP client; parallel `callTool`; per-request abort (`packages/opencode/src/mcp/*` @ `v1.17.18`) |
| Keymaxxer | `/home/berend/src/contrib/keymaxxer` **0.2.0** (`packages/cli/src/mcp.ts`, `client.ts`, `approver.ts`) |
| MCP SDK | `@modelcontextprotocol/sdk` **^1.29.0** — handlers start concurrently (`Protocol._onrequest` does not await prior handlers) |

---

## Decision summary

1. **Place concurrency control in the facade** (shared Layer A→B gate). Do not rely on current Keymaxxer alone: it has unlock/approval races under concurrent tools.
2. **Single-flight unlock** across all HTTP clients: one passphrase dialog; all waiters share one result.
3. **Global human-dialog lane**: serialize unlock, approval, and add-secret UI so stacked OS dialogs never appear.
4. **Approval coalescing**: waiters for the same sensitive secret set share one dialog decision; Allow-session still lives only in upstream Keymaxxer’s `approved` set.
5. **After dialogs are not needed**, allow concurrent `keymaxxer_list` / already-approved `keymaxxer_run` / `keymaxxer_rm` so long runs do not block list.
6. **Disconnect = Layer A only**: cancel that session’s pending responses; never close the upstream keyholder; never cancel other sessions’ work.
7. **Cancellation** does not tear down shared unlock or shared approvals; orphaned upstream runs may finish without delivering a result.
8. **Timeouts**: client MCP timeout ≥ 300s for dialog paths; facade must not impose a shorter dialog timeout; optional cap + queue for concurrent secret-bearing runs (backpressure).

---

## As-is behavior (why rules are required)

### MCP SDK

`Protocol._onrequest` attaches an `AbortController` per request id and starts the handler with `Promise.resolve().then(() => handler(...))` **without** waiting for other in-flight handlers. Concurrent tool calls on one connection are first-class.

Client cancel / transport close aborts those controllers and sends `notifications/cancelled` for outstanding client requests. Keymaxxer tool handlers **ignore** `extra.signal`.

### OpenCode remote clients

- Each OpenCode process is an independent Streamable HTTP MCP client with its own `mcp-session-id`.
- Within one process, parallel model tool use issues concurrent `tools/call`s.
- Per-server `timeout` (default 30s if unset) applies to connect and tool calls; progress tokens reset the timer (`resetTimeoutOnProgress: true`). Dialog-heavy tools need **≥ 300_000** ms.
- Disconnect closes that client only; remote Keymaxxer is not OpenCode’s child process.

### Keymaxxer `serve()` (sole keyholder)

| State | Scope | Notes |
| --- | --- | --- |
| `store` | Process | Lazy unlock via GUI / env; no single-flight |
| `approved: Set<string>` | Process | Secret **names** only; Allow-session shared for all tools in this process |
| Dialogs | OS processes | No mutex; concurrent prompts stack |
| Idle re-lock | Optional | `KEYMAXXER_IDLE_MINUTES` closes store and **clears all** approvals |

Critical races today:

| Race | Effect |
| --- | --- |
| Concurrent first `vault()` | Two passphrase dialogs; two DB opens; last write wins for `store` |
| Concurrent `runGated` for same secret | Two approval dialogs; non-deterministic set updates |
| Concurrent `keymaxxer_add` | Competing add dialogs |
| Idle re-lock mid-flight | Store closed under active run; approvals wiped for everyone |
| Client disconnect mid-dialog | Dialog can keep running; no cancel linkage |

Multi-process Keymaxxer (N stdio servers) would give N unlocks and N approval sets — exactly what the broker forbids. The broker keeps **one** stdio `keymaxxer serve` and multiplexes HTTP clients onto it.

---

## Required concurrency model

```
Harness / OpenCode A / OpenCode B
        │  concurrent tools/call (per HTTP session)
        ▼
┌───────────────────────────────────────────┐
│ Facade (Streamable HTTP McpServer)        │
│  • per-session request tracking           │
│  • shared DialogLane (mutex + coalesce)   │
│  • optional RunLane (concurrency limit)   │
│  • disconnect isolates Layer A only       │
└───────────────────┬───────────────────────┘
                    │ tools/call forward
                    ▼
            one keymaxxer serve
            (store + approved set)
```

### Layer responsibilities

| Concern | Facade | Upstream Keymaxxer |
| --- | --- | --- |
| HTTP session lifecycle | Own | Unaware |
| Unlock single-flight / dialog queue | **Must gate** | Should also single-flight (nice; not sufficient alone) |
| Approval coalescing / dialog mutex | **Must gate** | Should also coalesce (nice) |
| Allow-session / once / deny semantics | Pass through | **Sole owner** of `approved` |
| Secret values / scrubbing | Never touch values | Sole owner |
| Idle re-lock | Observe only; lifecycle ticket | Owner of timer |

Do **not** reimplement approval policy or vault crypto in the facade (per #109). The facade only **orders and coalesces** human-interactive and multi-client-unsafe entry into the upstream client.

---

## Rules

### 1. Serialization and dialog lane

**Rule D1 — Global dialog lane.** At most one human-facing interaction runs at a time across the whole sidecar:

- Vault unlock (passphrase)
- Approval (deny / once / session)
- Add-secret UI

Implementation shape: a shared async mutex (`dialogLane`) acquired before any upstream call that may open a dialog, released when that call returns (success, deny, cancel, or error).

**How the facade knows a call may dialog:**

| Tool | May dialog? | Gate |
| --- | --- | --- |
| `keymaxxer_list` | Unlock only (if locked) | Acquire dialog lane **only while vault is locked**; after unlock, list is free |
| `keymaxxer_run` | Unlock + approval if sensitive secrets not yet session-approved | Dialog lane for unlock/approval phase; run body may leave the lane (see R2) |
| `keymaxxer_add` | Unlock + add UI | Always dialog lane for whole call |
| `keymaxxer_rm` | Unlock only | Same as list |

**Practical simplification (acceptable for v1):** hold the dialog lane for the entire upstream `tools/call` of `keymaxxer_run` / `keymaxxer_add` when the vault is locked **or** when `keymaxxer_run` includes any secret that is not known to be non-sensitive-and-unlocked-path. Without a facade-side sensitivity cache, **v1 may serialize all `keymaxxer_run` and `keymaxxer_add`**, and only parallelize `keymaxxer_list` / `keymaxxer_rm` after first successful unlock.

**Preferred v1.1:** after first unlock, maintain a facade-side **read-only cache** of last `keymaxxer_list` metadata (names + sensitivity flags only) plus a mirror of session-approved names inferred from successful runs (or an explicit non-secret status channel later). Then:

- `list` / `rm` / non-sensitive `run` / already session-approved `run` → no dialog lane
- sensitive unapproved `run` / `add` / locked vault → dialog lane

Never cache secret **values**.

### 2. Unlock single-flight and deduplication

**Rule U1 — One unlock.** While Layer B is locked, concurrent tools that need the vault share a single in-flight unlock promise. Exactly one passphrase dialog.

**Rule U2 — Shared outcome.** All waiters resolve with the same success or the same failure (wrong passphrase / cancel). No partial “one client unlocked, another still locked.”

**Rule U3 — No second dialog on success.** After unlock succeeds, further tools skip unlock until idle re-lock or process restart (Layer B lifecycle — see lifecycle ticket).

Where to implement:

1. **Facade (required):** if the first post-start / post-relock tool fails open, the facade still must not issue two concurrent upstream calls that both trigger `openVaultServe`. Easiest: while `!unlocked`, all vault-touching calls enter a single-flight queue that runs **one** upstream call at a time until a successful vault-using call completes.
2. **Keymaxxer (recommended follow-up):** fix `vault()` to:

   ```ts
   let unlockPromise: Promise<SecretStore> | null = null;
   async function vault() {
     lastActivity = Date.now();
     if (store) return store;
     unlockPromise ??= openVaultServe(...).then((s) => { store = s; unlockPromise = null; return s; })
       .catch((e) => { unlockPromise = null; throw e; });
     return unlockPromise;
   }
   ```

### 3. Approval deduplication

**Rule A1 — One prompt per concurrent need.** If two (or more) `keymaxxer_run` calls need approval for overlapping sensitive secrets while a prompt is in flight, they must not open two dialogs.

**Rule A2 — Coalesce by secret-name set.** Waiters whose `needPrompt` set is a subset of an in-flight prompt’s set may share that decision:

- **session** → all waiters proceed; upstream `approved` gains those names (via the call that owns the dialog, or each waiter re-checks after dialog — second path must not re-prompt).
- **once** → only the **owner** call (the one that opened the dialog) may run with that one-shot grant; waiters with the same secrets must either re-prompt or get a clear error asking to retry (prefer: waiters re-enter approval after owner completes — if owner chose once, waiters still need their own once/session). Document this: **Allow once is per call, not coalesced.**
- **deny** → owner fails; waiters for the **same** secrets also fail with deny without a second dialog (shared deny). Waiters for **disjoint** secrets are unaffected.

**Rule A3 — Simpler v1.** Serialize all approval-capable `keymaxxer_run` through the dialog lane (full tool call). Then A1 holds automatically; A2 reduce to sequential natural behavior:

- First call: dialog → session → `approved` updated upstream  
- Second call: upstream sees approved → no dialog  

**Allow once** under serialization: first call once-runs without updating `approved`; second call prompts again — correct.

**Recommendation:** ship **A3 (serialize approval-capable runs)** for the prototype (#114). Keep A2 as an optional optimization only if parallel sensitive runs become a measured bottleneck.

### 4. Cancellation

**Rule C1 — Per-request only.** Cancel/abort of request R affects only R’s ability to deliver a result to its HTTP session.

**Rule C2 — Shared unlock.** If R is waiting on a shared unlock owned by another request, R leaving the waiter set must **not** cancel the unlock. If R is the sole owner of an in-flight unlock and all waiters are gone, the facade **may** abandon waiting for the dialog result for delivery purposes but **should not** kill the OS dialog mid-passphrase if other work might still use the eventual unlock within the same process tick — practical rule: **never kill unlock dialogs from cancel**; let them finish or time out; if unlock succeeds with zero waiters, keep the vault unlocked (Layer B benefit).

**Rule C3 — Shared approval (v1 serialize).** Cancel of R while R holds the dialog lane: release the lane when the upstream call settles; do not start a second dialog for R. If the user already approved session, the approval stands (upstream state).

**Rule C4 — Upstream run after secrets injected.** If R is cancelled mid-`keymaxxer_run` child process, the facade does **not** need to SIGKILL the child for v1 (Keymaxxer ignores MCP cancel). Prefer: let the child finish; drop the result if the HTTP session is gone. Optional later: plumb `AbortSignal` into Keymaxxer runner.

**Rule C5 — Cross-session isolation.** Cancel/disconnect on session A never aborts session B’s in-flight upstream calls and never clears `approved`.

### 5. Timeouts

| Path | Rule |
| --- | --- |
| OpenCode / Harness MCP client | `timeout` ≥ **300_000** ms for Keymaxxer remote entry |
| Facade → client | Do not fail a tool earlier than the client timeout while blocked on a human dialog |
| Unlock dialog (macOS Keymaxxer) | 120s → cancel unlock |
| Approval dialog (macOS) | 60s → deny |
| `keymaxxer_run` `timeoutMs` | Agent-supplied; facade passes through; no default required |
| Dialog lane wait | Waiters inherit the same human-dialog budget; no separate “queue wait” kill unless documented (optional: max queue wait = client timeout) |

### 6. Backpressure

**Rule B1 — Optional run concurrency limit.** Cap simultaneous upstream `keymaxxer_run` children (suggested default **4**). Excess wait in a FIFO queue.

**Rule B2 — Queue overflow.** If queue depth exceeds a configured max (e.g. **32**), return `isError` text to that caller without opening dialogs: `error: keymaxxer busy — too many concurrent runs`.

**Rule B3 — List priority.** `keymaxxer_list` and `keymaxxer_rm` (post-unlock) should not sit behind the run queue; only behind dialog lane when vault locked.

**Rule B4 — Fairness.** FIFO global queue is enough for v1. Per-session fairness is out of scope unless starvation appears in the prototype.

### 7. Disconnect and session teardown

**Rule X1 — Layer A only.** HTTP `DELETE` / transport close / OpenCode process exit:

- Abort pending facade handlers for that `mcp-session-id`
- Remove that session’s waiters from unlock/run queues
- **Do not** close stdio Keymaxxer
- **Do not** clear `approved` or lock the vault

**Rule X2 — In-flight owned by disconnected session.** If the disconnected session owned the dialog lane call, let the upstream call finish; apply U2/A semantics to any remaining waiters; discard the result that would have gone to the dead session.

**Rule X3 — Sidecar process shutdown (not single-client disconnect).** Reject new sessions; stop accepting tools/call; wait for in-flight with a drain timeout; then kill upstream `keymaxxer serve` (clears key + approvals). Details belong in the lifecycle ticket; concurrency only requires that **client disconnect ≠ drain**.

**Rule X4 — No cross-request corruption.** Never reuse JSON-RPC request ids across sessions; never write one session’s `CallToolResult` onto another session’s transport; one shared upstream Client is fine because the facade correlates each upstream call promise to exactly one Layer A waiter set.

---

## Recommended v1 gate algorithm

```
on tools/call(name, args, session):
  register pending(session, requestId)

  if name == keymaxxer_list or keymaxxer_rm:
    if !facade.unlocked:
      await dialogLane.run(() => forward(name, args))  // unlock side effect
      facade.unlocked = true on success
    else:
      return await forward(name, args)

  if name == keymaxxer_add:
    return await dialogLane.run(() => forward(name, args))

  if name == keymaxxer_run:
    // v1: entire run under dialog lane (serializes unlock + approval + run)
    return await dialogLane.run(() =>
      runLane.schedule(() => forward(name, args))  // runLane limit still applies inside
    )

  on session close:
    abort/drop pending for session; do not touch upstream process
```

v1.1 can narrow `dialogLane` to unlock/approval phases only once sensitivity/approval mirrors exist.

---

## What stays shared vs isolated

| Artifact | Shared across clients? | Lifetime |
| --- | --- | --- |
| Vault unlock (derived key in Keymaxxer process) | **Yes** | Until idle re-lock or sidecar/Keymaxxer exit |
| Allow-session set | **Yes** | Same as unlock session |
| Allow once | **No** (per call) | Single `keymaxxer_run` |
| Deny | Per call; coalesced waiters for same secrets may share deny | Immediate |
| HTTP MCP session | **No** | Client connection |
| Dialog lane / run queue | Process-global in facade | Sidecar process |
| Secret values | Never in facade or OpenCode | Child env of run only |

---

## Explicit non-goals (this ticket)

- Changing Keymaxxer’s Allow-session meaning (name-global for the vault session) — product semantics stay.
- Multi-host / remote Keymaxxer — out of map scope.
- Fixing Linux pinentry missing “Allow session” — platform gap; broker does not paper over it.
- Full Keymaxxer cancel plumbing — optional follow-up.
- Idle re-lock policy numbers — lifecycle ticket.

---

## Prototype implications (#114)

A throwaway prototype must demonstrate:

| Criterion | Concurrency rule that enables it |
| --- | --- |
| One vault unlock across concurrent OpenCode clients | U1–U3 + dialog lane |
| Shared Allow-session per secret | Single upstream process + A3 serialization |
| Allow once / deny preserved | A3 sequential runs; once not written to set |
| Survive client disconnect | X1–X2 |
| No raw secrets in results | Unchanged passthrough + Keymaxxer scrubbing |
| No duplicate unlock/approval prompts under parallel first use | D1 + U1 + A3 |

Suggested stress cases:

1. Two OpenCode processes call `keymaxxer_list` together while locked → one passphrase dialog.
2. Two processes call `keymaxxer_run` with the same prod secret while locked → one unlock, one approval; second run silent if session allowed.
3. Allow once on first run; second process still prompts.
4. Kill OpenCode A mid-approval → OpenCode B still completes or gets a clean error; vault session remains for B.
5. Concurrent `list` during a long `run` (v1 may block list if run holds dialog lane — document; v1.1 should not).

---

## Optional Keymaxxer upstream fixes (not blocking design)

1. Single-flight `vault()`  
2. Single-flight / mutex around `requestApproval` + `approved` update  
3. Honor `AbortSignal` to kill child on cancel  
4. Coordinate idle re-lock with in-flight runs (refcount)

Even with these, the **facade still needs** X1 disconnect isolation and multi-client session mapping; Keymaxxer fixes only harden the single keyholder under parallel tools.

---

## Sources

- Keymaxxer MCP session: `/home/berend/src/contrib/keymaxxer/packages/cli/src/mcp.ts`
- Gating: `/home/berend/src/contrib/keymaxxer/packages/cli/src/client.ts` (`runGated`, `openVaultServe`)
- Approvals: `/home/berend/src/contrib/keymaxxer/packages/cli/src/approver.ts`
- Store multi-process WAL: `/home/berend/src/contrib/keymaxxer/packages/sdk/src/store.ts`
- MCP SDK concurrency: `@modelcontextprotocol/sdk` `shared/protocol.js` (`_onrequest`)
- OpenCode remote MCP: `anomalyco/opencode` @ `v1.17.18` `packages/opencode/src/mcp/index.ts`, `catalog.ts`, `session/tools.ts`
- Facade contract: [`docs/research/109-keymaxxer-mcp-facade-contract.md`](./109-keymaxxer-mcp-facade-contract.md)
