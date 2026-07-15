# Pre-Commit Validation Before Local Review

After OpenCode implements a Work Item and before Review, Ready For Agent validates the worktree by staging changes and running the repository's git pre-commit hook via `git hook run --ignore-missing pre-commit`. Missing pre-commit hooks succeed. When the hook fails, the step continues the Implement OpenCode Session with the full hook output, asks it to fix the failures (without committing or opening a PR), then re-stages and re-runs the hook, repeating until the hook passes. The Step Run's maximum duration bounds the loop. OpenCode or staging failures fail the Step Run and leave Pre-Commit pending for Retry.

## Consequences

- Pre-Commit is a first-class Lifecycle Step between Implement and Review, not an optional verification command.
- The step stages with `git add -A` before each hook invocation so hooks that inspect the index see implementation changes even when OpenCode left them uncommitted.
- Missing pre-commit hooks succeed; a failing hook triggers OpenCode fix-and-retry rather than immediately failing the Step Run.
- Pre-Commit requires the Implement OpenCode Session so fix attempts continue that conversation.
