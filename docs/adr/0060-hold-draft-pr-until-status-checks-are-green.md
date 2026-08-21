---
status: accepted
amends:
  - 0014
  - 0028
---

# Hold Draft PR Until Status Checks Are Green

Watch no longer treats a settled draft observation as enough to mark the Work
Item PR ready for review. Reviewers are notified only after draft-phase checks
are green, or after the Check-Start Deadline when no checks ever register (the
no-CI carve-out). Red checks on a draft go to Investigate PR Status Checks
immediately and the PR stays draft while the agent fixes them.

The Watch-to-Mark-Ready transition guards are `green_checks_on_draft` (an
all-terminal successful aggregate, with no deadline wait) and
`draft_no_checks_after_start_deadline` (`no_checks` or only Expected PR Status
Checks at or after the Check-Start Deadline). The former `settled_draft` and
`fallback_draft_observation` guards are gone; `failed_checks_on_draft` is
removed so a failed aggregate never advances to Mark PR Ready for Review. Red
draft checks reuse the existing `status_check_handoff_needed` transition to
Investigate. A failed aggregate with no unhandled terminals keeps polling
until the deadline (`failed_checks_before_deadline_or_unknown_draft_state`)
and then fails the Watch Step Run retryably, matching the ready-phase
unresolved-checks path.

This amends ADR 0028's draft fast-path (any settled draft, including zero
registered checks, advanced immediately) and ADR 0014's assumption that Watch
reaches Mark Ready on green without a draft gating window. Ready-phase Watch,
the Ready-Phase Status Check Round shortcut, merge routing, and Check-Start
Anchor and Deadline arithmetic are unchanged. Because Mark Ready now sees
green-gated or no-CI draft evidence, the Repository setting that skips the
ready-phase round still applies.

## Considered Options

Keeping the ADR 0028 settled-draft fast-path would still notify reviewers
before CI appears or while it is red. A second draft-phase timer was rejected
because the existing Check-Start Deadline already bounds the no-CI wait.

## Consequences

- Reviewers are not notified about a harness PR until its draft-phase checks
  are green, or until the no-CI carve-out fires.
- Investigate-while-draft reuses Status Check Handoff; each CHECKS_TRIGGERED
  fix push creates a fresh Check-Start Anchor as today.
- A red aggregate is never promoted to ready for review.
