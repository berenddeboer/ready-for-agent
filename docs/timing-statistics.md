# Timing statistics

Open **Statistics** in the Harness navigation (`/statistics`). The accepted
prototype is preserved at commit `cdcf2c203` on the local branch
`prototype/statistics-timing`. The production page keeps its three views and
adds a step-level breakdown:

- **Overview:** lane distributions, averages, medians, P90s and longest tasks.
- **Task explorer:** execution versus elapsed time, search, outlier filters,
  sorting and paginated task rows.
- **Retry hotspots:** lanes and steps ranked by recorded time on extra attempts.
- **Step timings:** per-task and per-attempt totals and percentiles, including
  Pre-Commit. Opening a task here initially filters its attempts to that step.

Repository, completion window, Agent Backend, Model, view, Overview lane
and selected step are kept in the URL. Data refreshes every minute and on
demand. Task dialogs show recorded outcomes, reasons, queueing, Agent Turn
slot waits, and historical model provenance.

Opening Statistics without a valid window selects **This week**. Explicit
windows, including `window=28` and TanStack's numeric query values, are still
honored. Completion windows include **This week**, **Last week**, **This
month** and **Last month**, alongside the rolling 7/28/90-day windows and All
time. Calendar ranges use the browser's local timezone with Monday-start
weeks. Current week and month end now; previous periods end exclusively at
the start of the current week or month.

Agent Backend and Model are cohort filters, combined with repository and
window using AND. Backend is the Agent Backend captured on the Work Item, not
the repository's current setting. A model matches a Work Item when that model
was recorded as used on at least one retained agent execution, including
Build, Review, or a retry. A mixed-model Work Item matches either model, is
counted once, and keeps every Step Run, including non-agent steps and attempts
before the completion window. Filtered totals describe completed work
involving a model, not execution time attributable exclusively to that model.

**Unknown model** selects Work Items with no recorded historical model
identity. Those tasks remain in All models. Missing provenance is not guessed
from today's settings or from an explicit execution profile that was never
recorded as used. Partial history can match a recorded model, but it is not
presented as complete; the task dialog says when history is unavailable.
Choices come from retained history for the selected repository and window,
with model choices scoped by the selected backend. They are not taken from
currently installed backends or the live model catalog. A selected value with
no matches stays visible. Thinking level is not a filter.

## Measurement contract

- The cohort contains only Work Items currently in **Complete**, selected by
  `state_ready_at` in the half-open completion window `[from, to)`. Failed,
  Abandoned and unfinished Work Items are excluded. These statistics describe
  completed work, not overall success rates.
- Every retained Step Run for each selected Work Item is included, even when
  the attempt predates the completion window. All time has no hidden history
  limit. Deleted history cannot be reconstructed.
- **Execution** sums recorded `started_at` → `finished_at` durations, including
  failed and interrupted attempts, internal fix loops and waits inside a step.
  **Elapsed** is Work Item creation → Complete. Overlapping attempts can make
  summed execution exceed elapsed time.
- Missing or reversed timestamps are unknown, not zero. A per-task, lane or
  step total with an incomplete attempt is excluded from duration averages and
  percentiles; valid individual attempts still contribute to per-attempt
  statistics and recorded-time breakdowns. Cancelled/postponed attempts that
  never started do not make an otherwise complete execution total incomplete.
  Absent steps are not zero-duration samples. Sample counts are displayed.
- Percentiles use linear interpolation at `(n - 1) × percentile` over sorted
  durations. Long-tail tasks exceed the cohort's total-execution P90 before
  explorer search and outlier filters are applied.
- **Repeats** are extra started attempts of the same step within a Work Item.
  Watch PR Status Checks polling, postponed attempts and cancellations do not
  consume a repeat ordinal. Recorded repeat time is not an estimate of waste.
- Step queueing sums available queued → started intervals (or queued → finished
  for unstarted attempts). Agent Turn slot waits are already included in
  execution. Neither measure provides a complete accounting of human attention,
  pauses or all Worker Slot holds.

## Pre-Commit granularity

Standalone **Pre-Commit** timing includes the hook and its agent fix loop.
Hooks rerun inside **Review** belong to Review's duration. Individual hook
commands and internal Review Fix Rounds are not separately timed in historical
Step Run data. Per-task mode sums all attempts; per-attempt mode measures each
recorded execution separately.

## Data path

`WorkItemLifecycle.timingHistory` reads a compact, validated projection using
one filtered SQL join plus choice queries on the same repository/window cohort.
Model matching uses existence predicates so several recorded models do not
duplicate Work Items or multiply attempt durations. The GraphQL
`timingHistory(repositoryId, from, to, agentBackend, model, unknownModel)`
query uses millisecond numeric timestamps. It performs no live Forge or Agent
calls and does not read current settings or the live model catalog. The UI
computes statistics over the full selected cohort. Explorer pagination limits
rendered rows, not the underlying statistical sample.

Future agent executions record the model selected for that execution after
catalog admission. Review records the build and review models selected for
that Review. Other agent executions record the build model only, so an unused
review model resolved alongside it is not stored. Legacy Step Runs have no
provenance and stay unknown. Recorded history is not rewritten when settings
change or an Agent Backend is unavailable.

The Complete-only completion-time index narrows date-window reads, and the
existing `step_run(work_item_id, queued_at)` index serves the attempt join.
Payload size and browser aggregation cost still grow with the retained attempt
count: All time fetches the complete history on each one-minute refresh. Choose
a repository or shorter window to reduce this cost. If larger histories require
server aggregation or paged loading, preserve full-cohort totals and percentiles
rather than computing them from only the visible page.

SQLite integration tests cover cohort boundaries, repository isolation,
tasks without history and attempts before the window. GraphQL tests cover date
validation and millisecond serialization; statistical tests cover repeat
classification, missing durations and per-task versus per-attempt aggregation.
