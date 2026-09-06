# Ready for Agent: reporting

Served by ready-for-agent {{CLI_VERSION}}. Command syntax: `ready-for-agent --help` / `--usage`. If the running Harness `version` differs from this CLI, introspect GraphQL before selecting fields.

## What a good report says

Lead with what needs a human, not with a lane dump. Answer: what is actively running and for how long; what is blocked and on what; what finished; what the operator should do next. Per-step durations are the evidence — `IMPLEMENT[OK/1.3h] REVIEW[OK/30m] COMMIT[!!/2m]` tells the story that "needs human" alone does not.

Flag a **stall** when a `RUNNING` item has sat in one state far longer than that step warrants (~90 min for agent-driven steps such as Implement and Review, ~10 min for mechanical ones such as worktree creation). Agent steps genuinely take a long time; compare duration to the step's own norm.

## The windowing trap

`ready-for-agent status` and the kanban board share one **windowed** projection. It includes:

- every *unfinished* Work Item (plus retryable failures and Needs Human), and
- the newest 15 *non-retryable terminal failures*, and
- Complete/Abandoned items whose terminal moment falls in the **last 24 hours**.

Consequences:

- **"Nothing in Merged" does not mean nothing merged.** It means nothing merged *in the last 24 hours*. For real throughput use `committedPullRequestsCount` and `completedWorkItems`.
- **A terminal-failed Work Item can vanish from every repo-wide listing.** Close the issue on the Forge and a failed attempt becomes invisible to `status` *and* to `workItems` — but `workItems(repositoryId:, issueNumber:)` still finds it.

When a user says "issue #N disappeared", query that issue number before concluding anything was deleted.

## Lifecycle chips collapse repeated attempts

`lifecycleLabels` carries one entry per *phase*, not per run: `status` is the **latest** attempt's and `durationMs` is the **sum** across every attempt. A phase that failed for 50 minutes and then succeeded on retry in 3 renders as a single `IMPLEMENT[OK/54m]` — the failure is nowhere in the chip row. A long duration on an `OK` phase is often a retry story.

GraphQL exposes no per-attempt Step Run history. For that, open the Harness SQLite file **read-only**: `SQLITE_DATABASE_PATH` when set, otherwise the product data dir file `ready-for-agent.db` (Linux: `~/.local/share/ready-for-agent/`; macOS: `~/Library/Application Support/ready-for-agent/`; Windows: `%LOCALAPPDATA%\ready-for-agent\`). Table `step_run` is one row per attempt. The harness uses WAL — copy the `-wal` file too, or query the original with a read-only URI.

## Windowed status (CLI)

```bash
ready-for-agent status
ready-for-agent status github.com/owner/repo
```

Parse the JSON. Do not scrape prose. Repository selectors: `github.com/owner/repo`, `owner/repo`, or a unique final segment. Same shapes work for GitLab and Azure DevOps (`dev.azure.com/org/project/repo`).

## Pipeline snapshot (GraphQL)

Write the payload to a file; shell-escaping GraphQL inline wastes a turn.

```graphql
{
  version
  config { selectedAgentBackend maxConcurrentWorkItems unfinishedWorkItemCount }
  repositories { id projectPath paused mergePolicy issuesReconciledAt }
  kanbanStatus {
    lanes { id label count
      workItems { repository { projectPath }
        workItem {
          issueNumber issueTitle state status statusMessage canRetry
          stateResidenceMs pullRequestNumber sessionId
          lifecycleLabels { phase status durationMs }
          latestStepRunReason { code message retryAt }
        } } }
  }
}
```

`issuesReconciledAt` is how stale the issue projection is. `kanbanStatus.workItems` is a wrapper — Work Item fields live under `.workItem`.

**Do not select `pullRequestCount` in this query.** It counts open non-draft Forge PRs, not merged throughput, and a Forge failure on that field can null the entire response.

## Hidden Work Item

```json
{"query":"query($r:ID!,$n:Int!){ workItems(repositoryId:$r, issueNumber:$n){ id state status statusMessage failureCode lifecycleLabels { phase status durationMs } latestStepRunReason { code message retryAt } } }","variables":{"r":"repo-...","n":412}}
```

## Throughput (not windowed)

```graphql
completedWorkItems(page: 1, pageSize: 50) { totalCount page pageSize items { issueNumber state status } }
committedPullRequestsCount(from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z")
```

## Error detail

```graphql
{ workItems(repositoryId:"repo-...", issueNumber: 412) {
    latestStepRunReason { code message retryAt
      detail { code causeChain { name message } } } } }
```

`causeChain` names concrete error types and is the most precise failure signal.

Load `recovery` when translating a reason code into an action. Load `lifecycle` for the complete vocabulary.
