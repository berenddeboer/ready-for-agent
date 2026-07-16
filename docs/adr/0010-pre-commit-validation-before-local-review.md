# Pre-Commit Validation Before Local Review

After OpenCode implements a Work Item and before Review, Ready For Agent validates the worktree by staging changes and running the repository's git pre-commit hook via `git hook run --ignore-missing pre-commit`. Missing pre-commit hooks succeed. When the hook fails, the step writes the full hook output to a temp log, continues the Implement OpenCode Session with the log path (not raw hook logs), and asks it to use a sub-agent to inspect the failure and return only a concise summary of what to fix. The main session fixes without committing or opening a PR; Ready For Agent then re-stages and re-runs the hook, repeating until the hook passes. The Step Run's maximum duration bounds the loop. OpenCode or staging failures fail the Step Run and leave Pre-Commit pending for Retry.

## Consequences

- Pre-Commit is a first-class Lifecycle Step between Implement and Review, not an optional verification command.
- The step stages with `git add -A` before each hook invocation so hooks that inspect the index see implementation changes even when OpenCode left them uncommitted.
- Missing pre-commit hooks succeed; a failing hook triggers OpenCode fix-and-retry rather than immediately failing the Step Run.
- Fix prompts point at a log file and require a sub-agent to summarize failures so noisy hook output does not fill the main Implement session context.
- Pre-Commit requires the Implement OpenCode Session so fix attempts continue that conversation.
