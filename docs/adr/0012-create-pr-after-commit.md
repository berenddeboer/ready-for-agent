# Create PR After Commit

After Commit succeeds and before Complete, the Create PR Lifecycle Step continues the Implement OpenCode Session and asks it to open a pull request for the committed work in the Work Item worktree. Lifecycle Steps are harness orchestration; Create PR (like Implement, Review, and Commit) is performed by OpenCode, not by the harness shelling out to `gh pr create`. Keymaxxer launches this OpenCode continuation with the Repository's configured GitHub credential mapped to `GH_TOKEN` and `GITHUB_TOKEN`; token provisioning requests Issue read, Contents write, and Pull requests write permissions. The prompt requires the PR to reference the Work Item's GitHub Issue, follow repository PR conventions, and avoid merging. Success is OpenCode exit success; the harness does not inspect the resulting PR. Failure leaves Create PR pending for Retry.

## Consequences

- Create PR is a first-class Lifecycle Step between Commit and Complete.
- OpenCode owns push, PR title/body, base-branch choice, and whether an existing open PR for the branch is sufficient.
- Complete now means a PR was created (or an existing suitable PR was accepted), not only that commits exist locally.
