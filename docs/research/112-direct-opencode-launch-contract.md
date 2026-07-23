# Direct OpenCode launch contract

Resolution of [Define the direct OpenCode launch contract](https://github.com/berenddeboer/ready-for-agent/issues/112) (part of [Design a shared Keymaxxer broker for OpenCode](https://github.com/berenddeboer/ready-for-agent/issues/106)).

Depends on:

- [Specify the Keymaxxer MCP facade contract](https://github.com/berenddeboer/ready-for-agent/issues/109) — Streamable HTTP remote MCP shape; config key `keymaxxer`
- [Define sidecar and vault session lifecycles](https://github.com/berenddeboer/ready-for-agent/issues/111) — fixed loopback port; TCP readiness; Harness passes URL into OpenCode MCP config
- [Define the shared broker security model](https://github.com/berenddeboer/ready-for-agent/issues/113) — unguessable path capability URL; memory-only delivery; no Bearer; log host:port only

---

## Goal

Define how every OpenCode process is spawned **directly by the Harness**, configured with the authenticated remote Keymaxxer MCP, while:

1. Safely merging `OPENCODE_CONFIG_CONTENT`
2. Preserving Session continuation and output semantics
3. Eliminating Keymaxxer-owned OpenCode subprocesses
4. Keeping credentials available only through Keymaxxer tools — never as ambient OpenCode environment variables

---

## Spawn ownership

| Actor | Role |
| --- | --- |
| **Harness** | Sole parent of every OpenCode process via `@ready-for-agent/opencode` (Effect `ChildProcessSpawner`) |
| **OpenCode** | Child of Harness only; MCP **client** of the shared sidecar |
| **Keymaxxer Sidecar** | Never parents OpenCode |

### Hard cut

Once this design is implemented:

- **No** `keymaxxer_run` of an `opencode` command remains
- Create PR / investigate PR status checks / decide PR merge use only `Opencode.continue` (direct spawn + remote MCP)
- No dual-path feature flag and no emergency Keymaxxer-owned OpenCode fallback

Harness may still call `keymaxxer_run` for **non-OpenCode** work (e.g. GitHub helper bins that need `GITHUB_TOKEN` in their own child env).

---

## CLI and Session shape (preserved)

```text
opencode run --auto --format json --dir <cwd> -m <model> --variant <variant> [--session <id>] <prompt>
```

| Step | Session policy |
| --- | --- |
| Install fallback | `start`; session id discarded |
| Implement | `continue` when Work Item `sessionId` is set (Retry after interrupt/fail); otherwise `start` |
| Review, Commit, Create PR, Investigate PR checks, Decide PR merge | `continue` with Work Item `sessionId` |

- stdin: ignore  
- stderr: ignore  
- Default process timeout: 30 minutes (lifecycle `maxDuration` may override)  
- MCP client timeout inside forced config: ≥ 300000 ms (dialogs)

---

## `OPENCODE_CONFIG_CONTENT` merge

`makeOpencodeEnvironment` (called for every spawn):

1. Read parent `OPENCODE_CONFIG_CONTENT`, or `{}` if unset.
2. `JSON.parse`; must be a JSON object or throw.
3. Shallow-spread top-level config; shallow-spread `mcp`.
4. **Force-overwrite** `mcp.keymaxxer` (do not field-merge with a prior local/stdio entry):

```json
{
  "type": "remote",
  "url": "<capabilityUrl>",
  "enabled": true,
  "oauth": false,
  "timeout": 300000
}
```

5. Return at least `{ OPENCODE_CONFIG_CONTENT: JSON.stringify(...) }` for the child env override.

### Capability URL wiring

- Required constructor input: `keymaxxerMcpUrl` on `Opencode.layer` / the environment builder.
- Harness holds the full capability URL **in memory only** (stdout bootstrap per #113) and passes it in.
- The Opencode package **must not** read the capability from a secret-bearing environment variable.
- **Fail closed** if the URL is missing or empty: refuse to spawn OpenCode. No local-stdio Keymaxxer fallback; no “disable Keymaxxer and run anyway.”

Remote config shape (security half from #113):

```json
{
  "mcp": {
    "keymaxxer": {
      "type": "remote",
      "url": "http://127.0.0.1:6057/<capability>/mcp",
      "enabled": true,
      "oauth": false,
      "timeout": 300000
    }
  }
}
```

No `headers.Authorization`. Local stdio `keymaxxer` for the same server must not be left enabled.

---

## Child environment / credential boundary

- Spawn with `extendEnv: true`.
- **Strip** from the OpenCode child env before spawn: `GH_TOKEN`, `GITHUB_TOKEN`, and any `GITHUB_TOKEN_*`.
- Capability reaches OpenCode **only** via forced `OPENCODE_CONFIG_CONTENT` (`mcp.keymaxxer.url`).
- OpenCode never receives secret **values** in its environment. Secret use goes through Keymaxxer MCP tools (`keymaxxer_list`, `keymaxxer_run`, `keymaxxer_add`).

### GitHub-using lifecycle steps

1. Harness resolves the repository secret **name** via `findSecret` (provider `github`, account `owner/name`) — **pre-flight**.
2. If none configured → clear credential error **before** spawn.
3. On success → put the **name only** in the prompt (e.g. use Keymaxxer secret `GITHUB_TOKEN_…` via `keymaxxer_run` for `gh`). Never put the value in env or prompt.

Applies to Create PR, Investigate PR status checks, and Decide PR merge.

---

## Output / API semantics

One spawn path for all steps. NDJSON on stdout (`--format json`).

`start` / `continue` always fold the stream for:

| Field | Meaning |
| --- | --- |
| `sessionId` | From any NDJSON object with non-empty `sessionID` (required for success on start; continue may fall back to known id) |
| `assistantText` | Concatenated assistant text parts from NDJSON `type === "text"` events (may be empty) |

Result shape: `{ sessionId, assistantText }`.

| Consumer | Uses |
| --- | --- |
| Implement / Review / Commit / Create PR | `sessionId` + exit code; ignore `assistantText` |
| Investigate PR checks / Decide PR merge | Parse machine tags from `assistantText` (existing `READY_FOR_AGENT_RESULT: …` conventions) |

Exit / timeout errors may still carry a partial `sessionId` when seen (current package behavior).

---

## Logging

- Never log full `OPENCODE_CONFIG_CONTENT` or the capability URL (or path segment).
- Logs/metrics may show **host:port** only.
- Aligns with #113 redaction rules for Harness and the Opencode package.

---

## Explicitly rejected alternatives

| Rejected | Why |
| --- | --- |
| Inject `GH_TOKEN` / `GITHUB_TOKEN` into OpenCode env for GitHub steps | Breaks “credentials only via Keymaxxer tools”; reintroduces ambient secret surface |
| Preserve parent `mcp.keymaxxer` when present | Could re-enable local stdio Keymaxxer / second keyholder |
| Deep-merge remote keymaxxer fields | Callers could override `url` / disable remote broker |
| Spawn with Keymaxxer disabled if URL missing | Silent loss of credential tools; fails late and opaquely |
| Read capability from OpenCode process env | Extra ambient secret; package should take explicit layer input |
| Full env allowlist (`extendEnv: false`) in v1 | Higher churn; stripping GitHub token vars is sufficient with Harness not holding tokens ambient |
| Dual-path / flag / Keymaxxer-owned OpenCode fallback | Leaves two launch contracts; map requires Harness-direct spawn |
| Drop pre-flight `findSecret` | Long agent runs that only then discover missing credentials |
| Separate capture vs non-capture spawn APIs | Unnecessary; always extract both session and text |

---

## As-is → to-be (implementation delta)

| Area | Today | Target |
| --- | --- | --- |
| Create PR / investigate / decide-merge | Shell via `keymaxxer_run` with token env | `Opencode.continue` direct spawn |
| `makeOpencodeEnvironment` | Forces `mcp.keymaxxer.enabled: false` only | Forces remote MCP entry with capability URL |
| `Opencode.layer` | No URL input | Requires `keymaxxerMcpUrl` |
| Run result | `{ sessionId }` | `{ sessionId, assistantText }` |
| OpenCode env | Full inherit | Inherit minus `GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_TOKEN_*` |
| GitHub prompts | Tokens ambient; no secret name in prompt | Secret **name** in prompt after Harness pre-flight |

---

## Acceptance checklist (for implementers)

- [ ] Every OpenCode process is parented by Harness; zero `keymaxxer_run` of `opencode`
- [ ] `mcp.keymaxxer` always remote + capability URL + `oauth: false` + timeout ≥ 300s
- [ ] Missing URL → refuse spawn
- [ ] OpenCode child env never contains GitHub token values
- [ ] Create PR / investigate / decide-merge use `Opencode.continue` and pre-flight secret name
- [ ] Result includes `sessionId` and `assistantText`; machine-tag steps parse text
- [ ] Session continue flags and CLI args unchanged from current shape
- [ ] Logs never emit full capability URL or full `OPENCODE_CONFIG_CONTENT`
