# Merge PR after clanker decision

After Decide PR Merge returns clanker merge, the Work Item advances to Merge PR. The step uses the Repository GitHub token through `GitHubService` GraphQL (not `gh` or OpenCode) to find the open pull request on the Work Item's deterministic branch, revalidate the current head's aggregate checks, and call `mergePullRequest` with squash and `expectedHeadOid`. An already merged PR is a success (idempotent). A non-green head or concurrent push fails safely and leaves Merge PR pending for Retry. When Decide PR Merge returns needs-human (including Auto-merge disabled), the Work Item is terminal Needs Human and Merge PR does not run.

## Consequences

- Complete means the PR was squash-merged by the harness after a clanker merge decision, not only that risk was assessed.
- Merge stays deterministic and Keymaxxer-injected like Mark PR Ready for Review; OpenCode only decides, it does not merge.
- Repository credentials need Contents write (and Pull requests write) so the merge mutation can succeed.
