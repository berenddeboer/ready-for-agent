# Merge PR after clanker decision

After Decide PR Merge returns clanker merge, the Work Item advances to Merge PR. The step uses the Repository GitHub token through `GitHubService` GraphQL (not `gh` or OpenCode) to find the open pull request on the Work Item's deterministic branch, revalidate the current head's aggregate checks, and call `mergePullRequest` with squash and `expectedHeadOid`. An already merged PR is a success (idempotent). A non-green head or concurrent push fails safely and leaves Merge PR pending for Retry. When Decide PR Merge returns needs-human (including Auto-merge disabled), Merge PR does not run; human merge is handled by Refresh + local cleanup (ADR 0020), not by this step.

## Consequences

- The clanker path still squash-merges via the harness after a clanker merge decision.
- Human-merge Complete has no Merge PR Step Run (ADR 0020).
- Merge stays deterministic and Keymaxxer-injected like Mark PR Ready for Review; OpenCode only decides, it does not merge.
- Repository credentials need Contents write (and Pull requests write) so the merge mutation can succeed.
