# Competing Issue-closing PR quarantine and Create PR race guard

When Refresh observes an active Issue-closing PR that is neither the persisted Work Item PR nor the pending PR on that Work Item's deterministic Create PR branch, the harness stops autonomous work. The unfinished Work Item becomes Needs Human with failure code `issue_closing_pull_request_unowned` so the operator can inspect the local attempt and Reset it. The Issue Reconciler remains the sole writer of the Issue store; Work Item Lifecycle owns interruption, queue cancellation, Worker Slot release, and the state mutation.

Exact ownership is the persisted Forge repository or project plus PR number. Branch-name matching never becomes durable ownership. Pending self-ownership exists only to cover the race where Create PR has already created the remote PR and Refresh runs before that number is persisted: source repository or project identity plus the deterministic branch suppress false competition and destructive Issue exclusion for that observation. A same-named branch from a fork or different source project remains competing. If required source identity is unavailable while a Work Item is in Create PR, competing classification for that Work Item is deferred until a later Refresh.

A competing PR stops eligible pre-cleanup operational Work Items even when another active Issue-closing PR is already the Work Item PR. Already Needs Human, local cleanup, Complete, Failed, and Abandoned Work Items are left unchanged. Reset removes local artifacts and history and does not mutate the competing PR.

## Consequences

- Refresh classifies active Issue-closing PRs after the Forge fetch against a fresh database snapshot of persisted Work Item PR identities and unfinished Create PR Work Items.
- The Issue Reconciler returns typed per-Issue competing-PR observations from the same Forge snapshot. Lifecycle applies one repository-batched stop command.
- GitHub drafts remain inactive for relevance; current GitLab draft-MR behavior is unchanged.
- Interruption cannot roll back a push, PR creation, Issue close, or merge already accepted by the Forge.
