# Azure DevOps

Azure DevOps is a first-class Forge: add a local clone the same way as
GitHub or GitLab. The harness lists Ready Issues, implements in a
worktree, opens a pull request, watches status checks, can merge, and
completes the Boards item after merge if Azure left it open.

## Ready discovery is a Boards tag

Azure Boards has no GitHub-style labels. Tag the work item
`ready-for-agent`. The harness lists open work items that carry that
Boards tag. A label on another surface is ignored.

Predecessor/Successor links on the work item show up as blockers
(`blockedBy`).

## Authentication

Until Azure credential UX ships, auth is the ambient PAT environment
variable:

```bash
export AZURE_DEVOPS_EXT_PAT=<your-pat>
```

There is no `az` CLI requirement. Minimum token scopes per lifecycle
step (poll Ready Issues, push, Create PR, Mark PR Ready for Review,
Watch/status checks, Merge PR, close-out) are tracked in
[issue #1213](https://github.com/berenddeboer/ready-for-agent/issues/1213).
Merge/complete needs more than git + create-PR; a narrower PAT can
implement and open a PR, then fail at Merge PR.

Create a PAT at
`https://dev.azure.com/<organization>/_usersSettings/tokens`.

## Empty repositories

An Azure Repos Git repository with no default branch is not usable
until you push an initial commit so `main` (or equivalent) exists.
Add may still succeed today; later worktree and Implement steps fail.
Push `main` first.

## Merge Policy

New Repositories default to Merge Policy `off` — a human must merge.
Azure orgs often have no pipelines. `off` plus no CI means every PR
waits for a human. **Always** is the unattended setting for a no-CI
Azure repo: after the Check-Start Deadline, absence of CI is green.
Pending, failed, and Expected checks still block Always.

## Boards close-out

Create PR links the Boards work item to the PR so Azure can complete
it on merge. After Merge PR reports the PR merged, if the Boards item
is still open the harness completes it itself: that work-item type's
Completed-category state (Done on Basic, Closed on Agile) plus the
hidden-marker completion summary, posted once. An item already Done or
Closed is left in state. Local cleanup then runs and the Work Item
reaches Complete.
