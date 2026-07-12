# Ready for Agent

Opinionated agentic software engineering harness that works GitHub issues into PRs for configured repositories.

## Language

**Repository**:
A GitHub repository the harness is configured to work on, identified by owner and name (case-insensitive identity; display casing preserved). One row per GitHub repo; the harness keeps a single local clone of it (bare or working). Displayed as `owner/name` — no separate display label.
_Avoid_: Repo (in formal docs), target, project, checkout

**Paused**:
A Repository state in which the harness does not process the repo (no issue polling, worktrees, or jobs) while keeping the configuration. New Repositories start paused until deliberately unpaused.
_Avoid_: Disabled, inactive, enabled=false
