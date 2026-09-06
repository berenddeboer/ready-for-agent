# Ready for Agent: operating

Served by ready-for-agent {{CLI_VERSION}}. Command syntax: `ready-for-agent --help` / `--usage`. If the running Harness `version` differs from this CLI, introspect GraphQL before mutating.

These operations write Harness state. `intake` and `implementNow` spend real agent tokens. Reset is documented in `recovery`, not here.

## Repository selectors

`github.com/owner/repo`, `github.com://owner/repo`, `owner/repo`, or a unique final segment such as `repo`. Case-insensitive. Azure DevOps: `dev.azure.com/org/project/repo` or its unique final segment.

## Inspect before launching work

```bash
ready-for-agent candidates <repo>
```

Read-only. Prints current Intake Candidates as versioned JSON. **Always run this before `intake`**, and say how many items `intake` would launch.

```bash
ready-for-agent intake <repo>
```

Starts **every** current candidate. That can be dozens of concurrent agent runs. Prefer `implementNow` for a single issue.

Empty intake exits 0. Partial intake prints the result document on stdout and exits 1.

## Targeted retry, then autonomous retry

Retry creates a new Step Run, keeping the worktree, branch, PR, and Session. Use it when `canRetry` is true.

```bash
ready-for-agent retry <repo> --issue 412
ready-for-agent retry <repo> --work-item wi-...
ready-for-agent retry <repo> --all-retryable
```

`--all-retryable` is *Autonomous Retry*, capped by the Autonomous Retry Budget (default 3 attempts per Work Item at its current step). Explicit `--issue` and `--work-item` retries are not capped. Prefer the targeted form when you already know which item you mean.

Retry is rejected while the Work Item is paused. Start it first.

## Pause and Start (GraphQL)

No CLI verbs. They hold and release a Work Item without destroying anything. Pause does not interrupt a step that is already running.

```json
{"query":"mutation($id:ID!){ pauseWorkItem(workItemId:$id){ id paused status } }","variables":{"id":"wi-..."}}
{"query":"mutation($id:ID!){ startWorkItem(workItemId:$id){ id paused status } }","variables":{"id":"wi-..."}}
```

`interruptWorkItem` stops a *running* step on an already-paused item and keeps the worktree and Session.

## Start one issue (GraphQL)

```json
{"query":"mutation($r:ID!,$n:Int!){ implementNow(repositoryId:$r, issueNumber:$n){ id state status } }","variables":{"r":"repo-...","n":412}}
```

`implementLocally` stops before commit/PR so a human can inspect. `implementWith` pins backend/model/merge policy for that Work Item.

`queue` is not a generic “start later.” It is only for a Relevant open leaf Issue that has listed blockers and no unfinished Work Item. It creates a Work Item in Waiting for blockers (no Worker Slot, no Step Run). Actionable Issues use `implementNow` or `intake`, not `queue`.

```json
{"query":"mutation($r:ID!,$n:Int!){ queue(repositoryId:$r, issueNumber:$n){ id state status } }","variables":{"r":"repo-...","n":412}}
```

## Add a repository

```bash
ready-for-agent add /path/to/local/repo
```

Inspects a local clone and adds it to the running Harness. Correct inferred identity with `--forge-host` / `--project-path` when needed.

## Jump into a Session

```bash
ready-for-agent jump <session-id>
```

Takes over the current terminal (or opens a tmux window). Usage classifies `jump` as destructive: it replaces that terminal's foreground. Session IDs come from Work Item `sessionId`.

## Cost and reversibility

| Action | Tokens | Reversible | Notes |
| --- | --- | --- | --- |
| `candidates` | no | n/a | Always first |
| `intake` | **yes, many** | no | Fan-out; confirm count |
| `implementNow` | yes | no | One issue |
| `retry --issue` / `--work-item` | maybe | yes | Keeps worktree |
| `retry --all-retryable` | maybe, many | yes | Budget-capped fan-out |
| Pause / Start | no | yes | GraphQL |
| `jump` | no | n/a | Usage: destructive — takes over the terminal |
| Reset | no | **no** | See `recovery` |
