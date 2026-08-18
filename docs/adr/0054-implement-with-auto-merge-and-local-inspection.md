# Implement With Merge Policy pin and local inspection

Status: accepted (supersedes ADR 0052's remote-only/custom-local exclusion; the boolean Auto-merge checkbox and "not Merge Mode Always" rule are superseded by ADR 0059)

Implement With remains the only command that persists an Explicit Work Item Execution Profile. That type stays exclusively the immutable backend, build, and review selection. Merge Policy and pause behavior are a separate Implement With options input: a concrete Work Item Merge Policy pin and an optional Implement Locally inspection pause.

A Work Item Merge Policy pin is nullable. `null` (ordinary creation and omitted options) inherits the live Repository Merge Policy at merge-routing time. A concrete pin (`off` / `classify` / `always`) is the effective policy regardless of later Repository flips. Implement With `always` is the Always pin and skips Decide PR Merge (ADR 0059). Implement With `classify` still runs Decide PR Merge; `off` requires a human.

Implement With may reuse the existing `pauseBeforeStep = commit` local inspection contract. That pause is not a sandbox: Agent Turns and dependency installation keep their current capabilities, and Start continues to Commit and PR creation (or Close Issue for a No-Change Outcome). The one-click Implement Locally action is unchanged and still has no explicit profile.

Rejected alternatives: folding policy or pause fields into the execution profile; issuing a second `implementLocally` mutation; adding a lifecycle state; changing Repository Merge Policy or Harness Config from the dialog; adding these options to Queue, Repository Intake, or parent Implement All.

## Consequences

API callers that omit Implement With options keep repository-inherited, remote behavior. The Harness dialog always submits a concrete Merge Policy pin. Existing Work Item rows migrate to the pin encoding in ADR 0059.
