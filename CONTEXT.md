# Ready for Agent

Opinionated agentic software engineering harness that works GitHub issues into PRs for configured repositories.

## Language

**Repository**:
A GitHub repository the harness is configured to work on, identified by owner and name (case-insensitive identity; display casing preserved). One row per GitHub repo; the harness keeps a single local clone of it (bare or working). Displayed as `owner/name` — no separate display label.
_Avoid_: Repo (in formal docs), target, project, checkout

**Paused**:
A Repository state in which the harness does not autonomously process the Repository while keeping its configuration. Explicit operator requests, including a manual Refresh Job, remain allowed; new Repositories start paused until deliberately unpaused.
_Avoid_: Disabled, inactive, enabled=false

**Issue**:
A GitHub issue belonging to a Repository, identified within that Repository by a positive integer GitHub issue number and represented locally with its title, body, web URL, creation time, and GitHub state. The harness may retain a local representation for later use, but GitHub remains authoritative.
_Avoid_: Ticket, task (unless referring to a broader concept)

**Issue store**:
The harness capability that retains the Repository's current working set of Relevant Issue representations locally. It does not fetch, refresh, or establish the authoritative state of Issues.

**Issue Reconciler**:
The sole harness capability that changes the Issue store, deriving one Repository's Relevant Issues from GitHub's authoritative set of Ready-labeled Issues. Issues that are not Relevant, including Issues whose ready label was removed, are absent from the Issue store after reconciliation.
_Avoid_: GitHub Reconciler (too broad), Issue Synchronizer (suggests bidirectional updates)

**Refresh Job**:
A durable request for the Issue Reconciler to reconcile one Repository. Acceptance of a Refresh Job does not mean reconciliation has completed.
_Avoid_: Refresh (ambiguous between the request and its execution), sync job

**Keymaxxer Service**:
The backend boundary for vault operations. It can determine whether a named secret exists, request that a secret be added, and run a command with named secrets injected without exposing raw secret values to the Harness.
_Avoid_: Secret store, credential cache

**Keymaxxer Sidecar**:
A development-only companion process that owns the Keymaxxer MCP session so watched application-server reloads do not repeat vault-unlock or secret-use approval prompts.
_Avoid_: Credential daemon, token cache

**Session**:
An opencode conversation identified by opencode’s session id, scoped to a working directory, and continued across one or more prompt runs.
_Avoid_: chat, thread, conversation (in formal docs)

**Ready-labeled Issue**:
An Issue carrying the `ready-for-agent` GitHub label, regardless of whether the Issue is open or closed. A fetched Ready-labeled Issue includes its number, title, body, web URL, creation time, and GitHub state so consumers can decide whether it is actionable.
_Avoid_: Ready Issue (can imply that the Issue is open and actionable)

**Supported Issue Hierarchy**:
A GitHub issue hierarchy wholly contained within one Repository and limited to a root Issue with optional direct children. A hierarchy containing a cross-Repository relationship or a grandchild is unsupported in its entirety.
_Avoid_: Issue tree (implies arbitrary depth), nested Issues

**Parent Issue**:
A root Issue with one or more direct children. It organizes related work but is not itself a unit the harness works directly.
_Avoid_: PRD (the relationship does not establish document type), epic

**Child Issue**:
A direct child of a Parent Issue. In a Supported Issue Hierarchy, a Child Issue has no children of its own.
_Avoid_: Subtask, nested Issue

**Standalone Issue**:
A root Issue with no children. It is structurally eligible to be worked directly.
_Avoid_: Unparented Issue, top-level Issue

**Leaf Issue**:
An Issue with no children: either a Standalone Issue or a Child Issue. Only Leaf Issues are structurally eligible to be worked directly, subject to other workflow constraints.
_Avoid_: Actionable Issue (actionability also depends on workflow constraints)

**Relevant Issue**:
A Ready-labeled Issue in a Supported Issue Hierarchy that remains pertinent to the harness: either an open root Issue, or a direct child whose parent is open and Ready-labeled. A closed root Issue, or a child with a closed or non-Ready-labeled parent, is not relevant.
_Avoid_: Active Issue (a Relevant Issue may be closed), Actionable Issue (actionability also depends on workflow constraints), Visible Issue (presentation-specific)
