---
status: accepted
supersedes: 0013
amends:
  - 0014
  - 0027
---

# Bound PR Status Check Startup with Trigger-Anchored Deadlines

Replace Watch residence time, stale-head shortcuts, and consecutive-poll confirmation notes with one durable Check-Start Anchor and a Check-Start Deadline 90 seconds later. The latest PR creation, current-head push, observed draft-to-ready transition, or successful action expected to create replacement checks becomes the anchor; when GitHub omits a head push time, first observation of that head is the conservative fallback. This gives GitHub a fixed catch-up window without extending startup waiting after the event that can actually create checks.

Watch remains one Lifecycle Step but becomes draft-aware. A draft PR whose currently visible checks are settled and handled advances to Mark PR Ready for Review without waiting for its deadline; Mark PR Ready for Review returns to Watch and creates a fresh anchor, so any PR-creation checks that start late are still covered by the later ready-phase window. A settled non-draft PR advances to Decide PR Merge only at or after its deadline. An externally observed draft-to-ready transition creates the same anchor.

Watch polls every 30 seconds before the deadline and shortens the final delay to land on it. Terminal checks are handed off immediately. GitHub `EXPECTED` and `PENDING` are distinct: during the ready phase before the deadline, `no_checks`, `EXPECTED`, and an all-terminal observed set do not prove startup is complete; at or after the deadline, `no_checks` and `EXPECTED` no longer block, while an actual `PENDING` execution continues polling until terminal. Unknown mergeability remains an independent polling reason. At the deadline, an aggregate failure with no unhandled execution fails retryably immediately instead of entering a failed-confirmation poll.

Status Check Handoff outcomes distinguish `PROCESSED`, which expects no replacement execution and returns to Watch immediately, from `CHECKS_TRIGGERED`, which reports a completed push or successful restart, handles the old batch, and creates a fresh anchor before the normal poll delay. A successful harness-authorized whole-review rerun has the same anchor effect. Comment-driven `WAITING` is removed: once an automated-review check is terminal, its output is treated as fully published. A successful terminal review with no comment means no feedback, while a present but visibly incomplete review remains eligible for the bounded whole-workflow reruns established by ADR 0027.

## Consequences

- The 60-second `no_checks` grace, 120-second stale-head shortcut, second-green confirmation, failed-confirmation poll, and unbounded active-review wait loop are removed.
- A ready PR always receives at least 90 seconds after its latest check-triggering event before the harness concludes that every check has started, but checks that have actually started may run longer.
- Check-start anchors and undated-head observations must survive process restarts.
- A terminal review comment that appears only after its check finishes is intentionally ignored as provider inconsistency rather than recovered through polling.
