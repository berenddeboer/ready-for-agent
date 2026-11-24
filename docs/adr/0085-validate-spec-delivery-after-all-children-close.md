---
status: accepted
---

# Validate spec delivery after all children close

Accepted design; the Harness workflow is not yet implemented. The first
release covers GitHub Issues and Linear. Use the original Issue Tracker for
child relationships, closure reasons, comments, follow-ups, and parent closure.
This extends [ADR 0070](0070-independent-issue-tracker.md), which left automatic
parent completion outside the initial Linear integration.

A child can deliver a useful, defensible slice without delivering the whole
spec. In the hosted MCP rollout, the local implementation worked, but the
approved design also promised a deployed endpoint. Nothing owned that promise
once the last child closed. The final check belongs to the Harness, independently
of who implemented the children or whether their individual PRs should merge.

The spec-publishing workflow applies the [`spec` label](../agents/triage-labels.md#spec-label)
to the parent. The Harness initiates a separate **Spec Validation Work Item**
for that spec, never a validation ticket. This preserves the
[leaf-only implementation rule](0006-only-leaf-issues-are-work-units.md):
the validator assesses the integrated result; it does not implement the parent.
A [CI Repair Work Item](0075-ci-repair-work-item.md) is the existing precedent
for Harness-initiated work without a tracker ticket.

Watch marked, open specs, including pre-existing ones whose tickets are already
closed. Marking an existing open parent as a spec is sufficient for it to be
watched. Do not backfill historical closed specs or reopen one automatically
when a descendant changes. Explicitly reopening the parent puts it back under
observation.

Validation starts at the end, when the Issue Tracker confirms that all children
at every depth are closed, including human-owned and unlabelled children. A
closed intermediate ticket does not hide an open descendant. This is a tracker
hierarchy read for validation, not a change to the depth of implementation
intake. A partial or unreadable hierarchy cannot establish closure. A newly
published spec with zero children does not qualify. The filtered list
of Issues eligible for agent work cannot establish this. Pass each descendant's
tracker-reported closure reason to the validator so it can distinguish completed
work from a cancellation or “not planned” closure. An unavailable reason is
unknown, not evidence of completion. A cancelled duplicate may already be
covered elsewhere; cancelling the only ticket for a requirement does not waive it.
At most one Spec Validation Work Item may be unfinished for a spec. Repeated
observations of the same closure do not start another, even after a restart.
If a child is added or reopened during validation, withhold the verdict until
all children are closed again.

The validator works from the approved parent spec, the approved revisions of
design documents it incorporates, and explicit amendments to the spec. Preserve
the parent text and referenced design revisions at publication. For a spec
discovered later, use the approved versions if identifiable, otherwise use the
marked parent as written. Ask for a decision if conflicting versions would
change the verdict. A child PR may document its own limitations without thereby amending the parent's
promise. The validator chooses its own experiments to establish what actually
works. For example, it can exercise `/mcp` on the deployed backend rather than
inferring deployed behaviour from local tests or merely finding a route in code.
It records evidence against each requirement: met, unmet, or unverified. A
working local endpoint is evidence for local behaviour only.

A confirmed gap calls for a follow-up child ticket: `ready-for-agent` when
an agent can do the work, or `ready-for-human` when a person is needed. If
investigation leaves a decision unresolved, the validator requests a human
decision rather than filing a speculative implementation ticket. Neither a
follow-up ticket nor an unresolved decision establishes delivery. Filing and
labelling a child does not itself initiate implementation; ordinary intake
applies. The parent stays open while work or a decision is outstanding.

If one requirement is demonstrably unmet and another needs interpretation,
file the known gap immediately and put the validation Work Item in the existing
[Decision needed](../../GLOSSARY.md#decision-needed) handoff under Needs Human.
Report both on the parent. For this Work Item, explicit Resume continues
validation rather than returning to Implement. Retain an answer received while
a descendant is open and wait for all descendants to close before validating again.

When all children close again, validate the whole spec, reusing evidence where
it still applies. Read follow-up comments and the reason for closure before
deciding that a gap persists. A human can explicitly say the work is no longer
needed on the ticket itself: cite that decision rather than reopening the same
gap or claiming the omitted behaviour shipped. Interpret the decision in
context: rejecting one proposed implementation does not drop the requirement
if it could be met another way. No special wording is required. An agent's
deferral is not a human amendment, even if both post under the same tracker
account. If a pass depends on an ambiguous decision or its authorship, request
a decision. If nothing remains outstanding, publish the evidence and
dispositions on the parent and close it. If a known
gap persists without an explanation that resolves it, request a decision
rather than repeatedly filing the same ticket.

## Acceptance example (both trackers)

1. A marked spec promises local and deployed MCP. The agent's local work is
   merged. An open, human-owned descendant under a closed intermediate ticket
   keeps validation from starting.
2. The last descendant closes. One validation starts, even across another
   poll or restart. The local endpoint works; the deployed endpoint returns
   `404`. The validator cites both observations, creates a native follow-up
   under the parent, and leaves the spec open.
3. When that follow-up closes, the validator reads its closure reason and
   closing conversation. A working deployed endpoint is evidence of delivery.
   If the ticket was cancelled, a human comment saying hosted support is no
   longer needed is an amendment; the cancellation alone is not. The parent
   summary must say whether deployed behaviour was verified or waived.
