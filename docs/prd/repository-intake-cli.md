# Repository Intake and Kanban CLI

> Accepted implementation design derived from review of PR #934.
> Domain: `CONTEXT.md`; architecture: ADR 0051.

## Problem Statement

Automated operators need to discover all work a Repository can currently accept, start that work in one command, and inspect current progress without reproducing Harness lifecycle or Kanban rules. PR #934 demonstrated the workflow through a repository-local shell script, but duplicated eligibility, settings, retry, and status behavior outside the Harness and was not distributed with the operator binary.

## Solution

Add three finite commands to the published `ready-for-agent` CLI:

```text
ready-for-agent candidates <forge-host>/<project-path>
ready-for-agent intake <forge-host>/<project-path>
ready-for-agent status [<forge-host>/<project-path>]
```

`candidates` returns exactly the current Intake Candidates and their intended action. `intake` reclassifies current candidates and asks the Harness to process each sequentially through Implement Now or Queue. `status` returns the current six-lane Kanban projection, across all configured Repositories when its Repository argument is omitted.

The CLI is a thin GraphQL adapter. The running Harness owns all classification, preflight, Work Item creation, and Kanban projection behavior. Every finite command emits one versioned JSON document for automated callers; `start` retains normal long-running process logs.

## Domain Behavior

### Intake Candidates

An Intake Candidate is a Relevant, open Leaf Issue with no unfinished Work Item that currently qualifies for exactly one action:

- `IMPLEMENT_NOW`: the Issue is Actionable.
- `QUEUE`: the Issue is blocked and otherwise eligible for Queue.

Parent Issues, closed or irrelevant Issues, Issues with unfinished Work Items, and Issues with a completed Work Item are absent — including when the forge Issue is still open and ready-labeled because close-out missed. Callers never need to inspect hierarchy, blockers, or Work Item state to decide what Intake would attempt.

When classification returns no candidates, `candidates` succeeds with an empty list and does not run backend/model preflight. When candidates exist, the query applies the same Repository-scoped effective Agent Backend and resolved build/review Agent Model preflight as Intake before returning them. A caller therefore knows that every listed candidate passed shared Repository-level admission checks at query time, while ordinary per-Issue revalidation still occurs during a later Intake.

Candidate order is deterministic:

1. `IMPLEMENT_NOW` candidates by ascending Issue number.
2. `QUEUE` candidates by ascending Issue number.

Both `candidates` and `intake` require an explicit Repository. The argument is `<forge-host>/<project-path>`, split at the first slash and matched case-insensitively against one configured Repository. The CLI fails when no unique Repository matches. It does not accept an opaque Repository ID and does not infer the sole configured Repository.

### Repository Intake

Repository Intake is a synchronous best-effort operation, not an entity:

- It has no Intake ID, durable membership, progress record, history, explicit cancellation command, retry, or concurrency setting.
- It snapshots current candidate issue numbers and intended actions when the mutation begins.
- It runs candidates sequentially in candidate order.
- Each candidate goes through the ordinary authoritative Implement Now or Queue path, including per-Issue revalidation and normal Worker Slot admission.
- A candidate-local revalidation failure does not roll back successful candidates and does not stop later candidates.
- Candidate-local failures are limited to an Issue becoming missing, closed, a Parent Issue, blocked for Implement Now, unblocked for Queue, or already owning an unfinished Work Item. These are returned as per-Issue failures with the existing GraphQL error code.
- Repository disappearance, database/lifecycle storage failures, enqueue failures, invalid queue configuration, and unexpected defects are operation-level failures. They stop processing and surface as GraphQL errors. Work Items already committed by earlier candidates remain.
- A concurrent Issue or Work Item change is revalidated and, when it matches a candidate-local case, reported as that candidate's failure.
- The GraphQL HTTP request's abort signal must interrupt the Intake Effect. Processing then stops; already-created Work Items remain. This requires extending the current GraphQL Effect runner, which does not yet propagate request cancellation.
- Re-running the command is safe enough for this workflow because Issues with unfinished Work Items or a completed Work Item are no longer candidates.
- Zero candidates is a successful no-op and bypasses backend/model preflight.
- When candidates exist, one Repository-scoped preflight runs before any candidate is attempted. It applies the ordinary creation requirements to the effective Agent Backend and current resolved build and review Agent Model selections, including catalog membership when the backend reports a catalog. A failed preflight is a command-level failure and creates no Work Items.
- Repository Paused is not changed and does not block this explicit operator request, matching Implement Now and Queue.

Intake uses the current Issue projection. It neither requests nor waits for a Refresh Job and does not judge projection freshness. `issuesReconciledAt` is returned as evidence so a caller may apply its own policy.

### Kanban Status

Status is a one-shot, non-visual representation of the current Kanban, not Intake progress. Work Items from different Intake invocations and other operator actions are indistinguishable and are never grouped by Intake.

The ordered lanes and their meaning exactly match `docs/kanban.md`:

1. Queue
2. Build
3. Review
4. PR
5. Attention
6. Merged

The server owns lane classification and source-window policy. The visual board and CLI consume the same projection. The projection source set includes all working Work Items, the globally newest 15 terminal failures, and Complete/Abandoned Work Items in the rolling previous 24 hours. The optional Repository filter is applied after that shared source set is built, matching the visual Kanban's current global failed-history cap. Within Queue, Build, Review, PR, and Attention, Work Items are sorted newest first by `createdAt`; Merged is sorted newest first by `stateReadyAt`. Moving this policy server-side intentionally normalizes Attention to true newest-first ordering if the current client concatenation placed working Attention items before newer terminal failures.

Status without a Repository returns all configured Repositories. Status with a Repository uses the same explicit identity resolution as the other commands. No Repositories or empty lanes are successful empty results. Attention content does not make the command fail.

V1 has no watch flag, subscription stream, historical Completed view, or status filtering by Intake.

## GraphQL Interface

Add Harness-owned operations equivalent to:

```graphql
enum RepositoryIntakeAction {
  IMPLEMENT_NOW
  QUEUE
}

type IntakeCandidate {
  issueNumber: Int!
  title: String!
  url: String!
  action: RepositoryIntakeAction!
}

type RepositoryIntakeCandidates {
  repository: Repository!
  candidates: [IntakeCandidate!]!
}

type RepositoryIntakeCreated {
  issueNumber: Int!
  title: String!
  url: String!
  action: RepositoryIntakeAction!
  workItem: WorkItem!
}

type RepositoryIntakeFailed {
  issueNumber: Int!
  title: String!
  url: String!
  action: RepositoryIntakeAction!
  error: RepositoryIntakeIssueError!
}

type RepositoryIntakeIssueError {
  code: String!
  message: String!
}

union RepositoryIntakeIssueResult =
    RepositoryIntakeCreated
  | RepositoryIntakeFailed

type RepositoryIntakeResult {
  repository: Repository!
  results: [RepositoryIntakeIssueResult!]!
}

enum KanbanLaneId {
  QUEUE
  BUILD
  REVIEW
  PR
  ATTENTION
  MERGED
}

type KanbanWorkItem {
  repository: Repository!
  workItem: WorkItem!
}

type KanbanLane {
  id: KanbanLaneId!
  label: String!
  count: Int!
  workItems: [KanbanWorkItem!]!
}

type KanbanStatus {
  repository: Repository
  lanes: [KanbanLane!]!
}

extend type Query {
  intakeCandidates(repositoryId: ID!): RepositoryIntakeCandidates!
  kanbanStatus(repositoryId: ID): KanbanStatus!
}

extend type Mutation {
  startRepositoryIntake(repositoryId: ID!): RepositoryIntakeResult!
}
```

Names and exact composition may follow schema conventions, but these invariants are required:

- Candidate classification is implemented once and shared by query and mutation.
- `startRepositoryIntake` reclassifies; it does not accept candidate input or a plan token.
- Per-Issue outcomes are a discriminated union. Created and failed fields cannot coexist.
- The candidate-local error codes listed under Repository Intake are result data and processing continues. Repository resolution, preflight, cancellation, repository disappearance, persistence/queue infrastructure failures, and unexpected defects are GraphQL-level failures and stop processing.
- GraphQL errors preserve stable `extensions.code` values.
- No Intake persistence or database schema is added.
- `kanbanStatus` returns all sources when `repositoryId` is omitted.

## CLI JSON Contract

GraphQL returns domain data. The CLI alone owns the public JSON envelope and its version.

### Success Envelope

Every finite command writes exactly one compact JSON document to stdout:

```json
{
  "schemaVersion": 1,
  "command": "candidates"
}
```

There is no progress chatter. Help and argument-parser usage remain text because no command has executed.

Every Repository reference has this shape:

```json
{
  "id": "repository-id",
  "forge": "github",
  "forgeHost": "github.com",
  "projectPath": "berenddeboer/ready-for-agent"
}
```

JSON uses camelCase, ISO-8601 timestamps, explicit `null`, and forge-neutral names such as `pullRequestNumber`.

### Candidates

```json
{
  "schemaVersion": 1,
  "command": "candidates",
  "repository": {
    "id": "repository-id",
    "forge": "github",
    "forgeHost": "github.com",
    "projectPath": "berenddeboer/ready-for-agent"
  },
  "issuesReconciledAt": "2026-08-12T10:00:00.000Z",
  "candidates": [
    {
      "issueNumber": 101,
      "title": "Implement feature",
      "url": "https://github.com/berenddeboer/ready-for-agent/issues/101",
      "action": "IMPLEMENT_NOW"
    },
    {
      "issueNumber": 102,
      "title": "Blocked follow-up",
      "url": "https://github.com/berenddeboer/ready-for-agent/issues/102",
      "action": "QUEUE"
    }
  ]
}
```

`issuesReconciledAt` may be `null`.

### Intake

```json
{
  "schemaVersion": 1,
  "command": "intake",
  "repository": {
    "id": "repository-id",
    "forge": "github",
    "forgeHost": "github.com",
    "projectPath": "berenddeboer/ready-for-agent"
  },
  "issuesReconciledAt": "2026-08-12T10:00:00.000Z",
  "results": [
    {
      "issueNumber": 101,
      "title": "Implement feature",
      "url": "https://github.com/berenddeboer/ready-for-agent/issues/101",
      "action": "IMPLEMENT_NOW",
      "outcome": "CREATED",
      "workItem": {
        "id": "work-item-id",
        "state": "CREATE_WORKTREE",
        "status": "QUEUED"
      }
    },
    {
      "issueNumber": 102,
      "title": "Blocked follow-up",
      "url": "https://github.com/berenddeboer/ready-for-agent/issues/102",
      "action": "QUEUE",
      "outcome": "FAILED",
      "error": {
        "code": "UNFINISHED_WORK_ITEM_EXISTS",
        "message": "Issue #102 already has an unfinished Work Item"
      }
    }
  ]
}
```

The CLI exits `0` only when every result is created or when the result list is empty. It exits `1` when any candidate failed, while still writing the complete result document to stdout.

### Status

```json
{
  "schemaVersion": 1,
  "command": "status",
  "repository": null,
  "lanes": [
    {
      "id": "QUEUE",
      "label": "Queue",
      "count": 1,
      "workItems": [
        {
          "repository": {
            "id": "repository-id",
            "forge": "github",
            "forgeHost": "github.com",
            "projectPath": "berenddeboer/ready-for-agent"
          },
          "id": "work-item-id",
          "issueNumber": 102,
          "issueTitle": "Blocked follow-up",
          "state": "CREATE_WORKTREE",
          "status": "WAITING_FOR_BLOCKERS",
          "statusMessage": "Waiting for blocking Issues",
          "paused": false,
          "canRetry": false,
          "latestStepRunReason": null,
          "pullRequestNumber": null,
          "createdAt": "2026-08-12T10:00:00.000Z",
          "updatedAt": "2026-08-12T10:00:00.000Z",
          "stateReadyAt": "2026-08-12T10:00:00.000Z",
          "postponedUntil": null
        }
      ]
    }
  ]
}
```

All six lanes are always present in fixed order, including lanes with `count: 0` and an empty `workItems` array. A Repository-scoped invocation returns that Repository object instead of `null`. Every Work Item row includes authoritative Harness-owned `canRetry`. Stopped items expose `latestStepRunReason` with a stable machine `code`, operator-facing `message`, and bounded sanitized `detail` cause chain when persisted. These fields are additive on `schemaVersion` 1. The CLI does not infer eligibility from lane or status strings and does not inspect Agent Backend transcripts.

### Command-Level Errors

A command-level failure writes exactly one versioned JSON document to stderr and exits `1`:

```json
{
  "schemaVersion": 1,
  "command": "intake",
  "error": {
    "code": "AGENT_BACKEND_UNAVAILABLE",
    "message": "Agent Backend is unavailable"
  }
}
```

Harness domain failures retain their GraphQL `extensions.code`. CLI-owned failures use stable codes such as `HARNESS_UNREACHABLE`, `HARNESS_VERSION_MISMATCH`, `REPOSITORY_NOT_FOUND`, and `REPOSITORY_AMBIGUOUS`. A missing GraphQL field the CLI requires is `HARNESS_VERSION_MISMATCH` (newer CLI against an older running Harness), not a raw `GRAPHQL_VALIDATION_FAILED`. Numeric exit codes remain intentionally small: `0` success, `1` executed-command failure, and the CLI framework's normal usage exit for invalid arguments.

The existing finite `add` command moves to the same envelope and returns canonical Repository identity plus `localPath` and `isBare`. This is an intentional output-format change; no text compatibility mode is added.

## Implementation Seams

1. **Harness classification module**: a pure classifier over current Issues and unfinished Work Items returns ordered Intake Candidates. GraphQL query and mutation use this one interface.
2. **Work Item lifecycle**: Intake delegates creation to ordinary Implement Now and Queue behavior; it does not duplicate their validation or admission implementation.
3. **GraphQL API**: owns Repository preflight, sequential best-effort orchestration, per-Issue error conversion, and Kanban projection.
4. **Kanban projection**: move lane membership, source-window policy, and lane item ordering out of the browser-only classifier. Keep lifecycle-chip presentation helpers client-side; both visual board and CLI consume server-classified lanes.
5. **Generated GraphQL client**: extend the existing `GraphqlApi` CLI module. Preserve GraphQL error codes instead of collapsing failures to message-only errors.
6. **CLI**: parse the external Repository identity, resolve it through configured Repositories, call the typed GraphQL operations, construct the versioned envelope, serialize once, and set the exit code.

Do not add a shell script, direct database access, Forge authentication, backend/model selection, repository unpause, Auto-merge changes, transcript parsing, automatic Retry, or client-side lifecycle classification.

## Security And Deployment

Commands target the running Harness at `READY_FOR_AGENT_GRAPHQL_URL`, defaulting to loopback. A non-loopback endpoint is trusted operator infrastructure under the current Harness security model; this feature does not add Intake-specific authentication or weaken browser same-origin checks. API authentication and authorization remain a separate Harness-wide decision.

## Testing Decisions

Completion requires tests through the public seams:

1. **Classifier tests**: open Actionable Leaf → Implement Now; blocked eligible Leaf → Queue; parents, closed/irrelevant Issues, and unfinished Work Items absent; deterministic ordering.
2. **GraphQL Intake tests**: candidate query, empty candidate behavior, one-time preflight, sequential admission, Queue routing, partial failure continuation, Repository Paused behavior, and no Intake persistence.
3. **GraphQL Kanban tests**: all six lanes, precedence rules, exact failed/completed windows, lane ordering, item ordering, Repository filter, and all-Repositories view.
4. **Harness UI tests**: visual board consumes the server projection while preserving existing lane placement and behavior.
5. **CLI tests**: exact versioned JSON for `add`, `candidates`, `intake`, partial Intake, `status`, empty results, GraphQL error codes, unreachable Harness, stdout/stderr separation, and exit status.
6. **Live Harness e2e**: one controlled flow covering `candidates → intake → status` through the compiled CLI and real GraphQL endpoint.

Run verification through Nx targets for `lifecycle-model`, `graphql-schema`, `graphql-client`, `graphql-api`, `ready-for-agent`, and `harness`, followed by affected lint, typecheck, test, and e2e targets as applicable.

## Out Of Scope

- Dry run or an Intake Plan
- Refreshing or waiting for Issue reconciliation
- Intake IDs, groups, persisted membership, history, progress, explicit cancellation command, or status
- Applying a prior candidate list or snapshot token
- Per-Intake or CLI-set concurrency
- Intake scheduling or durable continuation after disconnect
- Watch/streaming status
- Retry or quota automation
- Agent Backend, model, Repository Paused, or Auto-merge configuration changes
- Parent Issue behavior or Implement All with Auto-merge
- Prompts, candidate caps, and interactive confirmation
- A compatibility wrapper for PR #934's shell script
