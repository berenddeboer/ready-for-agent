# Forge token scopes

Minimum token scopes the harness needs on each Forge, per lifecycle
step. Mint one token that covers the **full lifecycle** row for that
Forge; a narrower token will look “working” until it hits the first
step it cannot perform.

Repository-card **Create token** actions (GitHub and GitLab today;
Azure DevOps once the card can store a PAT) open the Forge’s token
page with these scopes selected or described. This file is the list
those actions point at.

Git over SSH does not consume the PAT for **push**; HTTPS git does.
API steps always use the token.

## Full lifecycle (mint this)

| Forge | Token | Minimum scopes |
| --- | --- | --- |
| **GitHub** | Fine-grained PAT, **Only select repositories**, this Repository | **Contents**, **Issues**, **Pull requests**, **Actions**, **Workflows**: Read and write. **Commit statuses**: Read-only. **Metadata**: Read-only (automatic). |
| **GitLab** | Personal access token on the Forge Host | `api` and `write_repository` |
| **Azure DevOps** | Organization PAT (`AZURE_DEVOPS_EXT_PAT` or the vault secret) | **Code: Read & write**. **Work Items: Read & write**. **Build: Read**. **Policy: Read** (under **Show all scopes**). |

GitHub’s Repository-card link preselects those fine-grained permissions.
GitLab’s link prefills `api,write_repository`. Azure’s token page
does not prefill scopes — select the Azure row by hand.

Classic GitHub PATs (`repo` + `workflow`) also work. Fine-grained
tokens cannot call the Checks API; the harness falls back to Actions
jobs and that 403 is expected.

## Per step

Each cell is the **minimum for that step alone**. Union the cells for
the steps you actually run; the table above is that union for the
full loop.

| Step | GitHub (fine-grained) | GitLab | Azure DevOps |
| --- | --- | --- | --- |
| poll Ready Issues | **Issues:** Read-only | `read_api` | **Work Items:** Read |
| push | **Contents:** Read and write. **Workflows:** Read and write if the branch includes `.github/workflows/**` | `write_repository` | **Code:** Read & write |
| Create PR | **Pull requests:** Read and write | `api` | **Code:** Read & write. **Work Items:** Read & write (Boards ArtifactLink) |
| Mark PR Ready for Review | **Pull requests:** Read and write | `api` | **Code:** Read & write |
| Watch / status checks | **Actions:** Read and write (job logs and workflow reruns). **Commit statuses:** Read-only | `read_api` | **Code:** Read. **Build:** Read (logs). **Policy:** Read (branch policy evaluations) |
| Merge PR | **Pull requests:** Read and write | `api` | **Code:** Read & write (same REST floor as Create PR). **Work Items:** Read & write (`transitionWorkItems` on complete — extra versus git + Create PR) |
| close-out | **Issues:** Read and write | `api` | **Work Items:** Read & write (comment + Completed-category state) |

### Azure DevOps: Merge PR needs more than git + Create PR

Git fetch/push and Create PR succeed with **Code (Read & write)**
alone. Completing the pull request does not: MERGE_PR PATCHes the PR
to `completed` with `transitionWorkItems: true`, and close-out writes
a Boards comment and Completed-category state. Those need
**Work Items (Read & write)** as well.

Azure REST documents both create and complete as **Code (Read & write)**.
Do not mint **Code (Read, write, & manage)** for Merge PR — that
scope is repository administration, not the complete floor.

A PAT that can clone, push, and open a PR will still fail at Merge PR
or close-out until Work Items write is present. Recreate the token;
existing PATs are not upgraded in place.

If complete still 403s after Code write + Work Items write, it is
Azure Repos **Contribute** / complete-PR permission (or a branch
policy), not a missing Code-manage PAT scope.

Create the token at
`https://dev.azure.com/<organization>/_usersSettings/tokens` (New
Token → custom scopes). The Repository-card Create action will use
that same org-scoped page.

## Repository permissions are not PAT scopes

The PAT is necessary but not sufficient. The identity behind the
token still needs Forge-side permission to complete a PR on a
protected branch (GitHub branch protection; GitLab Maintainer/merge
rights; Azure Repos **Contribute** / complete pull requests). Those
are Repository or project permissions, not token scopes.
