---
name: ready-for-agent
description: Operate and report on the Ready for Agent harness — the local metaharness that turns `ready-for-agent`-labelled issues (GitHub, GitLab, or Azure DevOps Boards) into merged PRs by driving a coding agent (OpenCode, Codex, Grok Build, Claude Code) through a Work Item lifecycle. Use this whenever the user asks what the harness is doing, how their issues/work items/PRs are progressing, why something is stuck, blocked, failed, or needs human attention, or wants to start, retry, reset, pause, or reconfigure work — and also when they just say things like "what's running", "check the queue", "how's the pipeline", "is it done yet", "why did #123 fail", "how many PRs this week", or mention the kanban board, lanes, work items, agent backends, or localhost:6056, even if they never say "ready-for-agent" by name.
---

# Ready for Agent

Ready for Agent is a **metaharness**: a deterministic loop that steers a coding
agent from a labelled issue to a merged pull request. It runs locally, on the
user's machine.

Before reporting on or operating the harness, load guidance that matches the
installed CLI:

```bash
ready-for-agent skills list
ready-for-agent skills get core
```

`core` routes to reporting, operating, recovery, and lifecycle skills. The CLI
serves content for its own version, so commands, flags, and reason codes stay
valid after upgrades.

## Before first use

`intake` starts **every** current candidate and spends real agent tokens;
`--all-retryable` can fan out. Load operating before those actions:

```bash
ready-for-agent skills get operating
```

Reset is irreversible and has no CLI verb. Load recovery before Reset or
Needs Human:

```bash
ready-for-agent skills get recovery
```

## Syntax

Command names, flags, examples, and environment variables: `ready-for-agent --help`
and `ready-for-agent --usage`. If the running Harness `version` differs from
`ready-for-agent --version`, introspect GraphQL instead of assuming API shapes.
