# GraphQL API reference

`http://127.0.0.1:6056/graphql` (override with `READY_FOR_AGENT_GRAPHQL_URL`).
No authentication — it binds loopback only unless started with `--host`.

This is the **complete** harness surface. The six CLI verbs are thin clients
over it, so anything the CLI cannot do (Reset, Pause, Start, `implementNow`,
session telemetry, settings) is available here.

## Contents

- [Calling it](#calling-it)
- [Queries](#queries)
- [Mutations](#mutations)
- [Input shapes](#input-shapes)
- [Recipes](#recipes)
- [Introspection](#introspection)

## Calling it

```bash
curl -s -X POST http://127.0.0.1:6056/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ version health }"}'
```

For anything with quotes or variables, write the payload to a file and use
`--data-binary @file.json` — shell-escaping a GraphQL document inline is a
reliable way to waste a turn.

Validation errors come back as `errors[].message` naming the offending field.
Trust them: they mean the running binary's schema differs from your query, and
the fix is [introspection](#introspection), not guessing.

## Queries

### Health and config

| Query | Returns |
| --- | --- |
| `version` | Harness version string, e.g. `"0.24.0"` |
| `health` | Boolean |
| `config` | `selectedAgentBackend`, `defaultModel`, `defaultThinkingLevel`, `reviewModel`, `reviewThinkingLevel`, `maxConcurrentAgentTurns`, `maxConcurrentWorkItems`, `unfinishedWorkItemCount`, `blockingUnfinishedWorkItemCount` |
| `agentBackends` | Installed backends |
| `agentBackendStatuses` | Per backend: `kind` (`READY` / unavailable), `reason`, `backend { id label }`, `models`, `warnings` |
| `models` | Model catalog |

### Repositories

`repositories` returns: `id`, `forge`, `forgeHost`, `projectPath`, `localPath`,
`isBare`, `paused`, `selectedAgentBackend`, `effectiveAgentBackend`,
`defaultModel`, `defaultThinkingLevel`, `reviewModel`, `reviewThinkingLevel`,
`mergePolicy`, `includeAllIssueAuthors`, `waitForReadyForReviewChecks`,
`issuesReconciledAt`, `blockingUnfinishedWorkItemCount`, `pullRequestCount`.

`issuesReconciledAt` is how fresh the issue projection is. If it is far in the
past, the harness has not polled the forge recently and the view is stale.

**`pullRequestCount` is a trap, twice over.** It counts **open non-draft PRs on
the forge**, regardless of Work Item ownership — not a merged-PR or throughput
number. Reporting it as "merged PRs" is wrong and makes a productive repository
look idle. For throughput use `committedPullRequestsCount` and
`completedWorkItems`.

It is also the riskiest field to select. It reaches the Forge API on every
request and it is `Int!`, so when that call fails — rate limit, auth, offline, a
repository the token cannot see — the non-null propagates up through
`[Repository!]!` and **nulls the entire response**: `data` comes back `null` and
every unrelated field in the same query is lost with it. Select it in its own
query and treat failure as unknown, rather than letting one Forge lookup cost a
whole progress report.

### Work Items

```graphql
workItems(
  repositoryId: ID!        # required
  issueNumber: Int         # one issue — bypasses the visibility filter
  listKind: WorkItemsListKind   # WORKING | FAILED | COMPLETED
  limit: Int
)
```

Fields:

| Field | Notes |
| --- | --- |
| `id` | `wi-...` |
| `issueNumber`, `issueTitle` | |
| `state`, `stateLabel` | Lifecycle position |
| `status`, `statusLabel` | How the step is going |
| `statusMessage` | Human-readable stop reason — often the whole diagnosis |
| `canRetry` | Whether Retry is available now |
| `isTerminal`, `paused` | |
| `pullRequestNumber` | |
| `sessionId` | Feed to `ready-for-agent jump` or the backend CLI |
| `worktreePath` | Usually under `/tmp/ready-for-agent/...` |
| `stateResidenceMs` | Time in current state — the stall signal |
| `lifecycleLabels` | `{ phase, label, status, durationMs }` per step |
| `latestStepRunReason` | `{ code, message, detail { code causeChain { name message } }, retryAt }` |
| `mergeMode` | `ORDINARY` \| `ALWAYS` |
| `failureCode` | Terminal failure classification |
| `executionProfile` | Pinned backend/model override, or null |
| `agentBackend` | `{ id label }` |
| `createdAt`, `updatedAt` | |

**Visibility:** without `issueNumber`, results are filtered to items that are in
a completed state, or working, **or** whose issue is still in the relevant-issue
store. Passing `issueNumber` skips that filter — use it to find a terminal
failure whose issue was closed.

### Kanban projection

```graphql
kanbanStatus(repositoryId: ID) {
  lanes { id label count workItems { repository { id projectPath } workItem { ... } } }
}
```

Same windowing as `ready-for-agent status` (see `lifecycle.md`). `workItems`
here is a `KanbanWorkItem` wrapper — the Work Item fields live under
`.workItem`, which is a common source of validation errors.

### Completed archive and throughput

```graphql
completedWorkItems(page: Int, pageSize: Int) { totalCount page pageSize items { ... } }
committedPullRequestsCount(from: String!, to: String!)   # ISO-8601, e.g. "2026-08-01T00:00:00Z"
```

Neither is subject to the 24-hour window — these are the honest throughput
numbers.

### Sessions and intake

```graphql
session(workItemId: ID!) {
  id availability backend { id label } model { ... } cost
  tokens { input output reasoning cacheRead cacheWrite }
  createdAt updatedAt
}
workItemBySessionId(sessionId: String!)
intakeCandidates(repositoryId: ID!)
issues(repositoryId: ID!)
```

`availability` is `AVAILABLE` | `MISSING` | `UNAVAILABLE` | `UNSUPPORTED`.
Backends prune old sessions, so token and cost telemetry on an older Work Item
frequently comes back `MISSING` with null fields — that is expected, not a bug.

## Mutations

### Starting work — spends real tokens

| Mutation | Effect |
| --- | --- |
| `implementNow(repositoryId, issueNumber)` | Full run: implement → review → PR → merge if allowed |
| `implementLocally(repositoryId, issueNumber)` | Stops before commit/PR so a human can inspect |
| `implementWith(repositoryId, issueNumber, profile, options)` | Run with a pinned backend/model profile; returns a one-element Work Item list |
| `implementAllWithAutoMerge(repositoryId, issueNumber)` | Parent issue → implements all children, merge policy Always |
| `queue(repositoryId, issueNumber)` | Enqueue rather than start immediately |
| `startRepositoryIntake(repositoryId)` | Start **every** current candidate — check `intakeCandidates` first |

### Controlling a Work Item

| Mutation | Reversible | Effect |
| --- | --- | --- |
| `retryWorkItem(workItemId): WorkItem!` | yes | New Step Run, keeps everything |
| `retryWorkItems(repositoryId, selector, maxAutonomousRetries)` | yes | Bulk retry |
| `startWorkItem(workItemId): WorkItem!` | yes | Clear Pause, resume |
| `pauseWorkItem(workItemId): WorkItem!` | yes | Hold; does not interrupt a running step |
| `interruptWorkItem(workItemId): WorkItem!` | yes | Stop a *running* step on an already-paused item |
| `resetWorkItem(workItemId): ID!` | **NO** | Deletes worktree, branch, Work Item, and all history |

### Repositories and config

`addRepository(input)`, `addLocalRepository(path)`,
`inspectLocalRepository(path)`, `removeRepository(repositoryId)`,
`refreshRepository(repositoryId)` (forces issue reconciliation),
`pauseRepository` / `unpauseRepository`, `updateRepositorySettings(input)`,
`updateConfig(input)`, `recheckAgentBackend(backendId)`,
`addRepositoryGitHubToken` / `addRepositoryGitLabToken`.

## Input shapes

`updateConfig` is a full-replace mutation, not a partial patch:
`selectedAgentBackend`, `maxConcurrentAgentTurns`, and
`maxConcurrentWorkItems` are all mandatory on every call, even when you only
mean to change one of them — read `config` first and echo back the fields
you don't intend to change. `defaultModel` (and the other model/thinking
fields) are the exception: `null` or omitted means "no explicit override —
inherit the Agent Backend's default," which is a valid resting state on
every call, whether or not `selectedAgentBackend` is also changing.

```graphql
input UpdateConfigInput {
  selectedAgentBackend: String!
  defaultModel: String
  defaultThinkingLevel: String
  reviewModel: String
  reviewThinkingLevel: String
  maxConcurrentAgentTurns: Int!
  maxConcurrentWorkItems: Int!
}

input UpdateRepositorySettingsInput {
  repositoryId: ID!
  forge: String
  forgeHost: String
  projectPath: String
  paused: Boolean!
  selectedAgentBackend: String
  defaultModel: String
  defaultThinkingLevel: String
  reviewModel: String
  reviewThinkingLevel: String
  mergePolicy: MergePolicy!      # OFF | CLASSIFY | ALWAYS
  includeAllIssueAuthors: Boolean!
  waitForReadyForReviewChecks: Boolean!
}

input RetryWorkItemsSelector {
  issueNumber: Int
  workItemId: ID
  allRetryable: Boolean
}

input ExplicitWorkItemExecutionProfileInput {
  agentBackendId: String
  buildModel: String
  buildThinkingLevel: String
  reviewSameAsBuild: Boolean
  reviewModel: String
  reviewThinkingLevel: String
}

input ImplementWithOptionsInput {
  mergePolicy: MergePolicy!      # OFF | CLASSIFY | ALWAYS
  implementLocally: Boolean!
}
```

Models must come from the backend's live catalog (`agentBackendStatuses.models`)
— an invented model id fails closed at the step rather than silently
substituting.

## Recipes

**Full pipeline snapshot** (what `rfa_report.py` runs):

```graphql
{
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

**Find a Work Item hidden from listings:**

```json
{"query":"query($r:ID!,$n:Int!){ workItems(repositoryId:$r, issueNumber:$n){ id state status statusMessage failureCode lifecycleLabels { phase status durationMs } } }",
 "variables":{"r":"repo-...","n":412}}
```

**Reset a Work Item** (destructive — read `statusMessage` first):

```json
{"query":"mutation($id:ID!){ resetWorkItem(workItemId:$id) }",
 "variables":{"id":"wi-..."}}
```

`resetWorkItem` alone returns a bare `ID!` scalar, so it takes **no selection
set** — `resetWorkItem(workItemId:$id){ id }` fails validation with "must not
have a selection since type ID! has no subfields". Its siblings differ:
`retryWorkItem`, `pauseWorkItem`, `startWorkItem`, and `interruptWorkItem` all
return `WorkItem!` and *do* take one. A validation failure is safe either way —
the mutation never executes, so a malformed Reset destroys nothing.

**Full error detail on a failure:**

```graphql
{ workItems(repositoryId:"repo-...", issueNumber: 412) {
    latestStepRunReason { code message retryAt
      detail { code causeChain { name message } } } } }
```

The `causeChain` names the concrete error types (`ImplementOpenCodeError`,
`AgentBackendExitError`, `CommitPublicationCopyError`) and is the most precise
signal available for why a step failed.

## Introspection

Field names move between releases. When a query fails validation, ask the live
schema:

```bash
# fields on a type
curl -s -X POST http://127.0.0.1:6056/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __type(name:\"WorkItem\"){ fields { name } } }"}'

# enum values
curl -s -X POST http://127.0.0.1:6056/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __type(name:\"WorkItemState\"){ enumValues { name } } }"}'

# input object shape
curl -s -X POST http://127.0.0.1:6056/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __type(name:\"UpdateConfigInput\"){ inputFields { name } } }"}'
```

Known drift: older releases exposed `Repository.autoMerge` (Boolean) where
current schemas carry `mergePolicy: MergePolicy!` (`OFF` / `CLASSIFY` /
`ALWAYS`). Check `version` and introspect before writing merge-related
mutations against an older harness.
