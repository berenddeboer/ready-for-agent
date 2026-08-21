---
name: ready-for-agent
description: Operate and report on the Ready for Agent harness — the local metaharness that turns `ready-for-agent`-labelled GitHub/GitLab issues into merged PRs by driving a coding agent (OpenCode, Codex, Grok Build, Claude Code) through a Work Item lifecycle. Use this whenever the user asks what the harness is doing, how their issues/work items/PRs are progressing, why something is stuck, blocked, failed, or needs human attention, or wants to start, retry, reset, pause, or reconfigure work — and also when they just say things like "what's running", "check the queue", "how's the pipeline", "is it done yet", "why did #123 fail", "how many PRs this week", or mention the kanban board, lanes, work items, agent backends, or localhost:6056, even if they never say "ready-for-agent" by name.
---

# Ready for Agent

Ready for Agent is a **metaharness**: a deterministic loop that steers a coding
agent from a labelled issue to a merged pull request. It runs locally, on the
user's machine, against their real clone — so everything you observe is live
production state, and everything you change is real.

Your two jobs are **reporting** (what is happening, and what needs a human) and
**operating** (starting, retrying, unblocking work). Reporting is the more
common one, and the one users are most often disappointed by, because the
obvious surface — `ready-for-agent status` — is a *windowed* view that silently
omits work. Getting reporting right is mostly about knowing which surface
answers which question.

## Mental model

An **Issue** labelled `ready-for-agent` on the forge is the source of truth. The
harness projects it locally and, when started, creates a **Work Item**: one
attempt to carry that issue through the lifecycle.

A Work Item has a **state** (where it is in the lifecycle: `IMPLEMENT`,
`REVIEW`, `COMMIT`, `MERGE_PR`, …) and a **status** (how that step is going:
`RUNNING`, `QUEUED`, `FAILED`, `NEEDS_HUMAN`, …). The pair is what you report —
`IMPLEMENT/RUNNING` and `IMPLEMENT/FAILED` are very different situations. The
board groups the pair into six **lanes**: Queue, Build, Review, PR, Attention,
Merged.

Work happens in a throwaway git worktree under `/tmp/ready-for-agent/...`, in a
backend **Session** you can reattach to. A Work Item that the harness cannot
advance alone stops in **Needs Human** and records why.

Read `references/lifecycle.md` for the full state, status, lane, and reason-code
vocabulary — reach for it whenever you need to explain precisely what a state
means, or map a reason code to a cause.

## Before anything else: is it running?

Every command here talks to a harness that must already be running. Check once:

```bash
ready-for-agent status >/dev/null 2>&1 && echo up || echo down
```

If it is down, start it detached and without stealing the user's browser —
`ready-for-agent` in the foreground blocks, which is almost never what you want
from a tool call:

```bash
ready-for-agent start --no-open   # run in background; UI at http://127.0.0.1:6056/
```

The finite commands (`status`, `candidates`, `intake`, `retry`, `add`, `jump`)
are thin GraphQL clients — they do **not** start the harness, and they fail with
a connection error if nothing is listening. A non-default port needs
`READY_FOR_AGENT_GRAPHQL_URL=http://127.0.0.1:<port>/graphql`.

## Reporting

Use the bundled script. It makes one round trip, then renders lane occupancy,
per-step timing, stall flags, blocked reasons, and next actions:

```bash
python3 scripts/rfa_report.py                    # everything
python3 scripts/rfa_report.py --repo acme-web    # one repo (substring match)
python3 scripts/rfa_report.py --throughput       # + merged-PR counts and archive
python3 scripts/rfa_report.py --issue 412 --repo acme-web   # one issue, deeply
python3 scripts/rfa_report.py --json             # raw, for your own analysis
```

The script exists because the interesting reporting data is spread across
`kanbanStatus`, `repositories`, `config`, and `agentBackendStatuses`, and
because per-step durations only become meaningful once you render them together.
Reproducing that inline every time wastes a turn and tends to drop the fields
that matter.

### The windowing trap

`ready-for-agent status` and the kanban board share one **windowed** projection.
It deliberately includes only:

- every *unfinished* Work Item (plus retryable failures and Needs Human), and
- the newest 15 *non-retryable terminal failures*, and
- Complete/Abandoned items whose terminal moment falls in the **last 24 hours**.

Two consequences you must hold onto when reporting:

- **"Nothing in Merged" does not mean nothing merged.** It means nothing merged
  *in the last 24 hours*. For real throughput use `--throughput`, which reads
  `committedPullRequestsCount` and the full `completedWorkItems` archive.
- **A terminal-failed Work Item can vanish from every repo-wide listing.** The
  repo-wide query only shows items that are completed, working, or whose issue
  is still in the relevant-issue store. Close the issue on the forge and a
  failed attempt becomes invisible to `status` *and* to `workItems` — but a
  direct `--issue N` query still finds it.

So when a user says "issue #N disappeared" or "where did that failure go",
reach for `--issue N` before concluding anything was deleted.

### What a good report says

Lead with what needs a human, not with a lane dump. A useful report answers:
what is actively running and for how long; what is blocked and on what; what
finished; and what the operator should do next. Per-step durations are the
evidence — `IMPLEMENT[OK/1.3h] REVIEW[OK/30m] COMMIT[!!/2m]` tells the story
that "needs human" alone does not.

**Lifecycle chips collapse repeated attempts.** `lifecycleLabels` carries one
entry per *phase*, not per run: the status is the **latest** attempt's and
`durationMs` is the **sum** across every attempt. A phase that failed for 50
minutes and then succeeded on retry in 3 renders as a single `IMPLEMENT[OK/54m]`
— the failure is nowhere in the chip row. So a clean-looking chip row does not
mean a clean run, and a long duration on an `OK` phase is often a retry story
rather than one slow attempt. When the history matters, say the duration is
cumulative, and read `step_run` in the SQLite database
(`~/.local/share/ready-for-agent/ready-for-agent.db`, one row per attempt) for
the actual sequence — the GraphQL API exposes no per-attempt step-run history.

Flag a **stall** when a `RUNNING` item has sat in one state far longer than that
step warrants (the script does this: ~90 min for agent-driven steps like
Implement and Review, ~10 min for mechanical ones like worktree creation).
Agent steps genuinely take a long time, so a raw duration is not itself alarming
— the comparison to the step's own norm is what makes it informative.

## Operating

You have full autonomy here, but the operations differ enormously in cost and
reversibility, so choose deliberately rather than reaching for the first one
that clears the error.

**Retry** creates a new Step Run for a failed or retryable Needs Human item,
keeping the worktree, branch, PR, and session. It is the cheap, safe,
almost-always-correct first move when `canRetry` is true. Most failures are
budget exhaustion or a malformed agent response, and simply run clean the
second time.

```bash
ready-for-agent retry <repo> --issue 412          # one issue
ready-for-agent retry <repo> --work-item wi-...   # one work item
ready-for-agent retry <repo> --all-retryable      # every retryable item
```

`--all-retryable` is an *Autonomous Retry* and is capped by the Autonomous Retry
Budget (default 3 attempts per Work Item at its current step); explicit
single-issue and single-work-item retries are not capped. Prefer the targeted
form when you already know which item you mean — it is bounded by intent rather
than by budget.

**Reset is destructive and has no undo.** It stops the run, deletes the git
worktree and branch, and erases the Work Item *and its entire Step Run history*,
returning the issue to Not Implemented. Unlike Abandon it preserves nothing.
Reset is the right call when the harness explicitly asks for it — most commonly
"Open Issue-closing PR #N is not owned by this Work Item", where a competing PR
already exists and the local attempt is genuinely worthless. Before resetting,
look at the PR the message names and tell the user what you found; erasing a
long Implement run to fix a message you have not read is how real work is lost.

Reset has no CLI verb — it is a GraphQL mutation (see `references/graphql-api.md`).

**Starting work** spends the user's real agent tokens and subscription quota, so
scale matters: starting one issue is routine, starting an entire backlog is not.

```bash
ready-for-agent candidates <repo>   # read-only: what would start
ready-for-agent intake <repo>       # starts EVERY current candidate
```

Run `candidates` before `intake`, every time, and say how many items `intake`
would launch. `intake` on a large backlog can start dozens of concurrent agent
runs. For a single issue use the `implementNow` mutation, or `implementLocally`
when the user wants to inspect the work before any commit or PR exists.

**Pause / Start** hold and release a Work Item without destroying anything, and
are the right tool when the user wants to stop the bleeding while they think.
Pause does not interrupt a step that is already running.

Repository selectors accept `github.com/owner/repo`, `owner/repo`, or just a
unique final segment like `repo` — the short form is fine and much easier to
read.

## Triage playbook

When something is stuck, the reason code and status message carry the diagnosis;
your job is to translate them into an action rather than re-deriving them.

| What you see | What it means | Do |
| --- | --- | --- |
| `canRetry: true` | The step failed but the path forward is intact | Retry |
| "Open Issue-closing PR #N is not owned by this Work Item" | Another PR closes this issue and the harness does not recognise it as its own | **Check the PR before Reset** — see below |
| "Issue #N is no longer present in the Issue store" | Issue was closed or unlabelled mid-flight | Nothing to fix; report it. Reopen/relabel to retry |
| `handler_failed` + "did not report valid READY_FOR_AGENT_RESULT" | The agent's final message was malformed | Retry; if it repeats, the model is too weak — suggest a stronger one |
| `agent_backend_unavailable` / `agent_backend_auth_rejected` | CLI missing from PATH, or not authenticated | Fix the CLI, then Recheck in Settings |
| `agent_model_not_in_catalog` | Configured model is gone from the backend catalog | Pick a current model in Settings |
| `missing_successful_checks` | Autonomous merge wanted green CI and did not get it | Retryable — returns to watching checks |
| `github_throttled` | Rate limited; stopped cleanly at GitHub's retry time | Wait for `retryAt`; do not hammer it |
| Paused | An operator held it | Start (Retry is rejected while paused) |

### The "unowned PR" message is not self-explanatory

`issue_closing_pull_request_unowned` invites a reflexive Reset, and that is
often wrong. The message is captured when the PR is observed and **goes stale**:
by the time you read it the PR has usually been merged, so "Open PR #N" may
describe something that closed days ago. Check the PR's real state and, more
importantly, its head branch:

```bash
gh pr view <N> --repo <owner/repo> --json number,state,headRefName,mergedAt
```

The harness names its own branches `rfa/<owner>-<repo>/<issue>/<work-item-id>`.
If the head branch carries **this Work Item's own id**, the PR *is* this Work
Item's work — it shipped, and ownership detection simply failed to reconnect it.
Nothing was lost, and Reset is just bookkeeping. If the branch is unrelated
(`fix/...`, someone else's work), a genuine competing PR closed the issue and
the local attempt really is redundant.

Either way the conclusion is usually Reset, but what you tell the user differs
completely: "your agent's work merged as PR #280, the harness lost track of it"
is a very different report from "someone else fixed this first". Say which.

To inspect what the agent actually did, reattach to its session — this is the
fastest way to answer "why did it do *that*":

```bash
ready-for-agent jump <session-id>   # takes over the terminal
opencode -s <session-id>            # or the backend CLI directly
```

Repeated failures across *different* issues usually indict configuration — a
weak model, an unavailable backend — rather than the issues. Say so, instead of
retrying each one in turn.

## Details on demand

- `references/lifecycle.md` — every state, status, lane rule, reason code, and
  failure code, with what each one implies for the operator.
- `references/graphql-api.md` — the full GraphQL surface at
  `http://127.0.0.1:6056/graphql`: queries, mutations, input shapes, and
  ready-to-run examples. Read this whenever you need something the CLI has no
  verb for — Reset, Pause, Start, `implementNow`, `implementLocally`, session
  token/cost telemetry, or per-repository settings.

## Facts worth not re-deriving

- The GraphQL endpoint is the complete surface; the CLI exposes only six verbs
  and every one of them is a thin client over it.
- CLI JSON output carries `schemaVersion` and, on failure, an `error` object
  with a `code` (for example `REPOSITORY_NOT_FOUND`) — parse it rather than
  matching on prose.
- Issues on the forge are authoritative. The local SQLite database is
  bookkeeping, and reconciliation runs on a poll — a freshly labelled issue takes
  a moment to appear, and `issuesReconciledAt` tells you how stale the view is.
- The API is versioned with the binary, and fields do move between releases
  (older releases exposed `autoMerge` where current ones carry a three-state
  `mergePolicy`). If a query
  fails validation, introspect the live schema rather than trusting this
  document:

  ```bash
  curl -s -X POST http://127.0.0.1:6056/graphql -H 'Content-Type: application/json' \
    -d '{"query":"{ __type(name:\"WorkItem\"){ fields { name } } }"}'
  ```
