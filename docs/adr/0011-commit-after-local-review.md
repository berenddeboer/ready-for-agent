# Commit After Local Review

After Review succeeds and before a future Create PR step, Ready For Agent creates a local git commit in the Work Item worktree. The Commit step stages with `git add -A` and runs `git commit` when the index is non-empty. An empty index after staging succeeds without creating a commit so already-committed worktrees remain re-entrant. Failure records full git output on the Step Run and leaves Commit pending for Retry.

## Consequences

- Commit is a first-class Lifecycle Step between Review and Complete (and before Create PR when that step exists).
- Pre-Commit remains validation-only; Commit is the step that records implementation changes as a git commit.
- Re-running Commit on a clean index is a no-op success.
