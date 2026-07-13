# Ready for Agent

Opinionated agentic software engineering harness that works GitHub issues into PRs for configured repositories.

## Language

**Repository**:
A GitHub repository the harness is configured to work on, identified by owner and name (case-insensitive identity; display casing preserved). One row per GitHub repo; the harness keeps a single local clone of it (bare or working). Displayed as `owner/name` — no separate display label.
_Avoid_: Repo (in formal docs), target, project, checkout

**Paused**:
A Repository state in which the harness does not process the repo (no issue polling, worktrees, or jobs) while keeping the configuration. New Repositories start paused until deliberately unpaused.
_Avoid_: Disabled, inactive, enabled=false

**Issue**:
A GitHub issue belonging to a Repository, identified within that Repository by a positive integer GitHub issue number and represented locally with its non-empty title and valid GitHub creation time. The harness may retain a local representation for later use, but GitHub remains authoritative.
_Avoid_: Ticket, task (unless referring to a broader concept)

**Issue store**:
The harness capability that retains Issue representations locally. It does not fetch, refresh, or establish the authoritative state of Issues.

**Keymaxxer Service**:
The backend boundary for vault operations. It can determine whether a named secret exists, request that a secret be added, and run a command with named secrets injected without exposing raw secret values to the Harness.
_Avoid_: Secret store, credential cache

**Keymaxxer Sidecar**:
A development-only companion process that owns the Keymaxxer MCP session so watched backend reloads do not repeat vault-unlock or secret-use approval prompts.
_Avoid_: Credential daemon, token cache

**Session**:
An opencode conversation identified by opencode’s session id, scoped to a working directory, and continued across one or more prompt runs.
_Avoid_: chat, thread, conversation (in formal docs)
