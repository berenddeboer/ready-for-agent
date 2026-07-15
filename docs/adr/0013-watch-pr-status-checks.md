# Watch PR Status Checks

After Create PR succeeds, the Work Item enters Watch PR Status Checks instead of completing immediately. The step queries GitHub for the open pull request on the Work Item's deterministic branch. Successful checks complete the Work Item, pending checks atomically enqueue another watch Step Run with a 30-second delay, and failed checks advance to Investigate PR Status Checks.

Investigate PR Status Checks continues the Implement OpenCode Session with the Repository GitHub credential. OpenCode inspects check logs, fixes, commits, and pushes when possible, then reports a structured outcome. A fix returns to a delayed Watch PR Status Checks run. A failure that cannot be fixed autonomously or requires a human decision moves the Work Item to the terminal Needs Human state with OpenCode's reason.

## Consequences

- Every poll and investigation is a separate Step Run, preserving durable execution history and at-least-once queue behavior.
- New Repository credentials request Actions read permission so OpenCode can inspect GitHub Actions check logs.
- A newly created PR that is not yet visible through GitHub is treated as pending; a visible PR with no configured checks is green.
- A merged PR completes the Work Item; a closed, unmerged PR enters Needs Human instead of polling forever.
- Needs Human is terminal and no longer blocks a later Implement Now request for the Issue.
- Complete now means the PR status checks are green, not merely that a PR exists.
