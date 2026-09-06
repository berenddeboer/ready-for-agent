# Ready for Agent: recovery

Served by ready-for-agent {{CLI_VERSION}}. Command syntax: `ready-for-agent --help` / `--usage`. If the running Harness `version` differs from this CLI, introspect GraphQL. Complete Step Run reason definitions: `ready-for-agent skills get lifecycle`.

Two vocabularies, do not mix them:

- `latestStepRunReason.code` is a Step Run reason from the ontology (`handler_failed`, `paused`, …).
- `failureCode` is a terminal Work Item classification (`issue_closing_pull_request_unowned`, `issue_not_found`, …).

Translate the matching field and `statusMessage` into an action. Do not re-derive the diagnosis.

## Triage (Step Run reasons and `canRetry`)

| What you see | What it means | Do |
| --- | --- | --- |
| `canRetry: true` | The step failed but the path forward is intact | `ready-for-agent retry <repo> --issue N` |
| Issue no longer in the Issue store | Issue was closed or unlabelled mid-flight | Report it. Reopen/relabel to retry |
| `handler_failed` + malformed `READY_FOR_AGENT_RESULT` | Agent's final message was malformed | Retry; if it repeats, the model is too weak |
| `handler_defect` | Internal harness defect | Report it; retry rarely helps |
| `agent_backend_unavailable` / `agent_backend_auth_rejected` | CLI missing from PATH, or not authenticated | Fix the CLI, then Recheck in Settings |
| `agent_model_not_in_catalog` / `thinking_level_not_in_catalog` | Configured model/effort gone from the catalog | Pick a current model in Settings |
| `build_model_not_configured` | No build model configured | Set one in Settings |
| `missing_successful_checks` | Autonomous merge wanted green CI and did not get it | Retryable — returns to watching checks |
| `github_throttled` | GitHub-only rate limit; stopped at GitHub's retry time | Wait for `retryAt`; do not hammer it |
| `paused` | An operator held it | Start (Retry is rejected while paused) |
| `timeout` / `interrupted` / `worker_restarted` | Budget, interrupt, or process restart | Retry |

Repeated failures across *different* issues usually indict configuration — a weak model or unavailable backend — rather than the issues.

## The unowned-PR `failureCode` goes stale

`failureCode` `issue_closing_pull_request_unowned` invites a reflexive Reset, and that is often wrong. The message is captured when the PR is observed and **goes stale**: by the time you read it the PR has usually been merged, so "Open PR #N" may describe something that closed days ago. Check the PR's real state and its head branch.

GitHub:

```bash
gh pr view <N> --repo <owner/repo> --json number,state,headRefName,mergedAt
```

Azure DevOps:

```bash
az repos pr show --id <N> --org https://dev.azure.com/<organization> --output json
```

The harness names its own branches `rfa/<owner>-<repo>/<issue>/<work-item-id>`. If the head branch carries **this Work Item's own id**, the PR *is* this Work Item's work — it shipped, and ownership detection failed to reconnect it. If the branch is unrelated, a genuine competing PR closed the issue.

Either way the conclusion is usually Reset, but tell the operator which: "your agent's work merged as PR #280" is not "someone else fixed this first".

## Reset is irreversible

Reset stops the run, deletes the git worktree and branch, and erases the Work Item **and its entire Step Run history**, returning the issue to Not Implemented. Unlike Abandon it preserves nothing. There is no CLI verb.

```json
{"query":"mutation($id:ID!){ resetWorkItem(workItemId:$id) }","variables":{"id":"wi-..."}}
```

`resetWorkItem` returns a bare `ID!` — it takes **no selection set**. `resetWorkItem(workItemId:$id){ id }` fails validation and does not execute. Siblings (`retryWorkItem`, `pauseWorkItem`, `startWorkItem`, `interruptWorkItem`) return `WorkItem!` and do take a selection set.

Read `statusMessage` and inspect the named PR **before** Reset.

## Inspect the Session

```bash
ready-for-agent jump <session-id>
```

Fastest way to answer "why did it do that". Session IDs come from Work Item `sessionId`.

## Failure codes on a terminal Work Item

These are `failureCode` values, not Step Run reasons.

| Code | Meaning |
| --- | --- |
| `issue_not_found` | The issue left the relevant-issue store mid-flight. Nothing to repair locally |
| `issue_closing_pull_request_unowned` | Another open PR already closes this issue. Review that PR, then Reset |
| `pr_status_checks_unresolved` | Still retryable — restores status-check watching |
