# Commit After Local Review

After Review succeeds and before Create PR, the Commit Lifecycle Step continues the Implement OpenCode Session and asks it to create a local git commit in the Work Item worktree. Lifecycle Steps are harness orchestration; Commit (like Implement, Review, and Create PR) is performed by OpenCode, not by the harness shelling out to `git commit`. The prompt requires the commit message to mention that it closes the Work Item's GitHub Issue and to follow the repository's commit conventions. Success is OpenCode exit success; the harness does not inspect git history. Failure leaves Commit pending for Retry.

## Consequences

- Commit remains a first-class Lifecycle Step between Review and Create PR.
- Pre-Commit is still harness-run git validation; Commit's work is OpenCode Session continue.
- OpenCode owns staging, message wording (including conventional commits when the repo requires them), and whether a no-op is appropriate when nothing remains to commit.
