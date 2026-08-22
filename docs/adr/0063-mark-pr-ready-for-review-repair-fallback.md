---
status: accepted
amends:
  - 0014
---

# Mark PR Ready for Review Uses Repair Fallback

Mark PR Ready for Review's native mutation (clearing a Work Item PR's draft
flag through the harness-owned Forge service) is rebuilt on the shared
Repair Fallback capability introduced for Commit and Create PR, rather than
leaving the step pending for an operator Retry on any native failure. On any
failure from the Forge's handler for this step — not a narrower subset such
as authentication only — the harness continues the Work Item's canonical
Session for one bounded Agent Turn asking the agent to finish marking the
pull/merge request ready for review, then independently re-checks the Forge's
own draft field rather than trusting the Agent Turn's own report. If the
pull/merge request is still a draft after both the native attempt and the
Agent Turn, the Step Run fails and the Work Item awaits a human, with no
further automatic retry.

The step needs no pre-check beyond the Work Item's worktree path (used only
as the Agent Turn's working directory) and a Session ID: unlike Create PR,
marking a pull/merge request ready for review needs no Forge credential
resolution for the Agent Turn.

## Consequences

- Mark PR Ready for Review is no longer classified Agent-free in the
  ontology: it may continue the Work Item's Session for one bounded Agent
  Turn when the native mutation does not establish that the pull/merge
  request is no longer a draft.
- The lifecycle ontology gains one transition from Mark PR Ready for Review
  back to Watch PR Status Checks reusing the existing agent-fallback outcome
  value, mirroring Commit's and Create PR's own agent-fallback transitions.
- A pull request that is stuck in draft after a native failure recovers
  automatically through the same Session, rather than requiring an operator
  to notice and manually intervene.
