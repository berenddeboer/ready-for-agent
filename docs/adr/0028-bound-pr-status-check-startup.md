---
status: accepted
amends:
  - 0014
  - 0027
---

# Bound PR Status Check Startup with Trigger-Anchored Deadlines

Replace Watch residence time, stale-head shortcuts, and consecutive-poll confirmation notes with one durable Check-Start Anchor and a Check-Start Deadline 90 seconds later. The latest PR creation, current-head push, observed draft-to-ready transition, or successful action expected to create replacement checks becomes the anchor; when GitHub omits a head push time, first observation of that head is the conservative fallback. This gives GitHub a fixed catch-up window without extending startup waiting after the event that can actually create checks.

Watch remains one Lifecycle Step but becomes draft-aware. A draft PR whose currently visible checks are settled and handled advances to Mark PR Ready for Review without waiting for its deadline; Mark PR Ready for Review returns to Watch and creates a fresh anchor, so any PR-creation checks that start late are still covered by the later ready-phase window. A settled non-draft PR advances only at or after its deadline: to Merge PR when the effective Merge Policy is Always, or to Decide PR Merge otherwise. An externally observed draft-to-ready transition creates the same anchor.

Repositories default to waiting for checks to start after ready for review, but may disable that wait with the live `waitForReadyForReviewChecks` Repository setting. When disabled, a known draft-to-ready transition with settled, non-failing draft-phase checks does not create a new 90-second startup wait: Mark PR Ready for Review advances directly to Merge PR when the effective Merge Policy is Always, or to Decide PR Merge otherwise, and Watch does the same after observing an external transition. The shortcut removes only the startup catch-up window. An execution already observed as pending still runs to completion, terminal results still receive normal handoff processing, and an abnormal aggregate failure with no unhandled execution still forces the ready-phase round. A PR first observed as ready retains its startup deadline because the harness has no settled draft-phase evidence.

The setting is evaluated when Mark PR Ready for Review or Watch durably chooses its next Lifecycle Step. Later setting changes do not rewind a Work Item that has already advanced to Decide PR Merge or Merge PR. Disabling this ready-transition wait does not affect Check-Start Deadlines anchored by PR creation, a head push, a check restart, or an automated-review rerun.

Watch polls every 30 seconds before the deadline and shortens the final delay to land on it. Terminal check executions are recorded as they appear. Unhandled green results accumulate while GitHub still reports an actual pending execution; once the aggregate settles, one Status Check Handoff carries the full unhandled batch. Unhandled red results and merge conflicts are still handed off immediately so recovery is not delayed by later checks. GitHub `EXPECTED` and `PENDING` are distinct: during the ready phase before the deadline, `no_checks`, `EXPECTED`, and an all-terminal observed set do not prove startup is complete; at or after the deadline, `no_checks` and `EXPECTED` no longer wait for startup, while an actual `PENDING` execution continues polling until terminal. Unknown mergeability remains an independent polling reason. At the deadline, an aggregate failure with no unhandled execution fails retryably immediately instead of entering a failed-confirmation poll. After the deadline, `EXPECTED` still does not satisfy harness-initiated merge. `no_checks` is green only for effective Always (ADR 0059); Classify and `off` still enter Needs Human instead of Decide PR Merge or Merge PR (ADR 0055).

Status Check Handoff outcomes distinguish `PROCESSED`, which expects no replacement execution and returns to Watch immediately, from `CHECKS_TRIGGERED`, which reports a completed push or successful restart, handles the old batch, and creates a fresh anchor before the normal poll delay. A successful harness-authorized whole-review rerun has the same anchor effect. Comment-driven `WAITING` is removed: once an automated-review check is terminal, its output is treated as fully published. A successful terminal review with no comment means no feedback, while a present but visibly incomplete review remains eligible for the bounded whole-workflow reruns established by ADR 0027.

## Consequences

- The 60-second `no_checks` grace, 120-second stale-head shortcut, second-green confirmation, failed-confirmation poll, and unbounded active-review wait loop are removed.
- Except for a Repository-authorized draft-to-ready shortcut, a ready PR receives at least 90 seconds after its latest check-triggering event before the harness concludes that every check has started; checks that have actually started may run longer.
- By default, a known draft-to-ready transition remains a check-triggering event. A Repository may assert that the transition cannot start relevant workflows and reuse its settled, non-failing draft-phase evidence instead, saving the ready-phase 90-second wait.
- Staggered green check completion produces one investigation after the aggregate settles rather than one Agent Turn per terminal green result.
- Check-start anchors and undated-head observations must survive process restarts.
- A terminal review comment that appears only after its check finishes is intentionally ignored as provider inconsistency rather than recovered through polling.
