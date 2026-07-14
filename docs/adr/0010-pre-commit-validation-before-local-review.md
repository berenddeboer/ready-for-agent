# Pre-Commit Validation Before Local Review

After OpenCode implements a Work Item and before Review, Ready For Agent validates the worktree by staging changes and running the repository's git pre-commit hook via `git hook run --ignore-missing pre-commit`. Failure blocks progress and records full hook output on the Step Run. Missing pre-commit hooks do not fail the Step Run; a failing hook does.

## Consequences

- Pre-Commit is a first-class Lifecycle Step between Implement and Review, not an optional verification command.
- The step stages with `git add -A` before invoking the hook so hooks that inspect the index see implementation changes even when OpenCode left them uncommitted.
- Missing pre-commit hooks succeed; a failing hook fails the Step Run and leaves Pre-Commit pending for Retry.
