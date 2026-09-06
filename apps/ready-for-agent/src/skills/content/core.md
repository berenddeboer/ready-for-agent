# Ready for Agent: core

Served by ready-for-agent {{CLI_VERSION}}. Command syntax, flags, examples, and environment variables come from `ready-for-agent --help` and `ready-for-agent --usage`.

If the running Harness `version` (GraphQL `{ version }`) differs from this CLI version, introspect the live GraphQL schema before writing queries or mutations. This document describes the serving CLI, not necessarily the process listening on port 6056.

## Load the skill that matches the task

| Task | Command |
| --- | --- |
| Status, windowing, what to tell an operator | `ready-for-agent skills get reporting` |
| Intake, retry, start/pause, launching work | `ready-for-agent skills get operating` |
| Stuck, failed, Needs Human, Reset | `ready-for-agent skills get recovery` |
| Lifecycle states and Step Run reason codes | `ready-for-agent skills get lifecycle` |

## Mental model

Ready for Agent is a **metaharness**: a deterministic loop that steers a coding agent from a labelled issue to a merged pull request. It runs locally, on the user's machine, against their real clone.

An **Issue** labelled `ready-for-agent` on the Forge is the source of truth. GitHub, GitLab, and Azure DevOps are first-class. When started, the harness creates a **Work Item**: one attempt to carry that issue through the lifecycle.

A Work Item has a **state** (where it is: `IMPLEMENT`, `REVIEW`, `MERGE_PR`) and a **status** (how that step is going: `RUNNING`, `QUEUED`, `FAILED`, `NEEDS_HUMAN`). Always report the pair. The board groups the pair into six **lanes**: Queue, Build, Review, PR, Attention, Merged.

Work happens in a throwaway git worktree (OS temp directory, often `/tmp/ready-for-agent/...`). A Work Item the harness cannot advance alone stops in **Needs Human** and records why.

## Is the Harness running?

GraphQL-backed commands (`status`, `candidates`, `intake`, `retry`, `add`, `jump`) fail if nothing is listening. Skill discovery does not need the Harness.

```bash
ready-for-agent status >/dev/null 2>&1 && echo up || echo down
```

If it is down, start it detached and without stealing the user's browser:

```bash
ready-for-agent start --no-open
```

UI: `http://127.0.0.1:6056/`. Non-default GraphQL URL: `READY_FOR_AGENT_GRAPHQL_URL`.

## Warnings before first use

- **Read vs write.** `status` and `candidates` are read-only. `intake`, `retry`, `add`, and `start` write. `jump` takes over a terminal.
- **Token spending.** Starting work spends the operator's real agent tokens. `intake` starts **every** current candidate.
- **Fan-out.** `ready-for-agent intake <repo>` can launch many concurrent agent runs. Always run `candidates` first and say how many items would start.
- **Destructive.** Reset has no CLI verb, no undo, and erases the Work Item and its Step Run history. Load `recovery` before Reset.

## JSON and exit semantics

GraphQL-backed finite commands emit exactly one compact JSON document. Success is stdout; failure is stderr with `{ schemaVersion, command, error: { code, message } }`. Parse `error.code` rather than matching prose. Exit 1 on failure. Partial `intake`/`retry` still print the result document on stdout and exit 1 when any item failed.

This `skills` command is offline. `list`/`get --json` still use `schemaVersion` and include this CLI's `version`. Unknown skill IDs fail non-zero with `SKILL_NOT_FOUND` on stderr.

## Live GraphQL when versions differ

The GraphQL endpoint is the complete Harness surface. The CLI is a thin client over a subset of it.

```bash
curl -s -X POST http://127.0.0.1:6056/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ version health }"}'
```

When a query fails validation, introspect:

```bash
curl -s -X POST http://127.0.0.1:6056/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __type(name:\"WorkItem\"){ fields { name } } }"}'
```

Known drift: older releases exposed `Repository.autoMerge` (Boolean) where current schemas carry `mergePolicy: MergePolicy!` (`OFF` / `CLASSIFY` / `ALWAYS`).

## Authoritative sources

| Question | Source |
| --- | --- |
| Command names, flags, examples, env | `ready-for-agent --usage` / `--help` |
| Lifecycle states and reason codes | `ready-for-agent skills get lifecycle` |
| Runtime API shape | Live GraphQL schema of the running Harness |
