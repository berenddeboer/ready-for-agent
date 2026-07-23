---
status: accepted
amended-by: 0028
---

# Mark PR Ready for Review

After Watch PR Status Checks reports green checks, the Work Item advances to Mark PR Ready for Review instead of completing immediately. The step uses the Repository GitHub token through `GitHubService` GraphQL (not `gh` or OpenCode) to find the open pull request on the Work Item's deterministic branch and call `markPullRequestReadyForReview`. An already non-draft PR is a success (idempotent). Failure leaves Mark PR Ready for Review pending for Retry.

## Consequences

- After success the Work Item advances to Decide PR Merge (see ADR 0015), not Complete.
- Checks green and the draft PR ready for review are preconditions for the merge-risk decision, not the end of the lifecycle.
- The harness remains free of `gh` for this step; Keymaxxer injects `GITHUB_TOKEN` into a small bin that runs `GitHubServiceLive`, matching get-pr-check-status.
- New Repository credentials still need Pull requests write so the mutation can succeed.
