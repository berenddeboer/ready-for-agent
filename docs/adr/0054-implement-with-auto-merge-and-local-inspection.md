# Implement With Auto-merge override and local inspection

Status: accepted (supersedes ADR 0052's remote-only/custom-local exclusion)

Implement With remains the only command that persists an Explicit Work Item Execution Profile. That type stays exclusively the immutable backend, build, and review selection. Publication policy and pause behavior are a separate Implement With options input: a concrete Work Item Auto-merge override and an optional Implement Locally inspection pause.

A Work Item Auto-merge override is nullable. `null` (ordinary creation and omitted options) follows the live Repository Auto-merge setting. `true` permits the existing risk-assessed Decide PR Merge flow for that Work Item even if Repository Auto-merge is later disabled. `false` requires human merge even if Repository Auto-merge is later enabled, without a merge-risk Agent Turn. The override is not Merge Mode Always: checked Auto-merge still runs Decide PR Merge and only a low-risk result advances to Merge PR.

Implement With may reuse the existing `pauseBeforeStep = commit` local inspection contract. That pause is not a sandbox: Agent Turns and dependency installation keep their current capabilities, and Start continues to Commit and PR creation (or Close Issue for a No-Change Outcome). The one-click Implement Locally action is unchanged and still has no explicit profile.

Rejected alternatives: mapping the Auto-merge checkbox to Merge Mode Always; folding policy or pause fields into the execution profile; issuing a second `implementLocally` mutation; adding a lifecycle state; changing Repository Auto-merge or Harness Config from the dialog; adding these options to Queue, Repository Intake, or parent Implement All.

## Consequences

API callers that omit Implement With options keep today's repository-inherited, remote behavior. The Harness dialog always submits both concrete checkbox values. Existing Work Item rows migrate to no override.
