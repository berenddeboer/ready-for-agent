---
status: accepted
supersedes:
  - 0074
amends:
  - 0068
---

# Repair red default-branch CI with an ordinary Work Item

ADR 0074's standalone repair agent ran outside the Work Item lifecycle with its
own deadline, attempt records, and broad authority. Operators could not watch
it on the pipeline, and it duplicated supervision the lifecycle already has.
Replace it with a **CI Repair Work Item**: a one-off Work Item whose input is
the Repository CI Gate's observation instead of an Issue. This is an accepted
design awaiting implementation.

## What is removed

Everything ADR 0074 introduced except the opt-in setting: the standalone repair
invocation, its four-hour deadline, persisted attempt records and their CI view
history, the per-incident automatic-attempt exhaustion rule, and the
`repair-ci-cd-pipeline` skill. No deprecation period or data migration beyond
dropping that state.

Kept: Repository CI Gate observation, CI Failure Incidents, Waiting for CI
Repair holds, and the per-Work-Item gate authorization from ADR 0068, renamed
**CI Gate Bypass** so "CI Repair" refers to the new Work Item. Operators keep
using CI Gate Bypass to move ordinary work across a Closed gate.

## The CI Repair Work Item

- Not backed by an Issue and never creates one. It records its origin as CI
  repair, skips Close Issue, and keeps its completion summary on the Work Item.
  Creating a tracker ticket instead was rejected: it adds issue creation and
  write permissions for every Issue Tracker and splits in-flight state between
  the tracker and the harness, while removing only the cheapest part of the
  design.
- Runs the standard lifecycle: Implement, Review, Commit, draft PR, Watch PR
  Status Checks, and the merge decision under the Repository's Merge Policy. It
  crosses a Closed gate by being a CI Repair Work Item. ADR 0074's exceptions to
  ADR 0017 and ADR 0055 end; harness-owned merge and successful-check rules
  apply again.
- Its prompt is short: default-branch CI has been red since the baseline (or
  last green run); inspect the failing runs and fix the causes. It carries
  links to the failing runs, and the agent reads logs itself with read access.
- The agent may conclude that nothing needs changing (already fixed, just
  wait) or that a rerun is needed. Both are No-Change Outcomes; a rerun request
  names the jobs and the harness performs it, so the agent needs no CI write
  access.
- It goes to the front of the Worker Slot queue. It does not preempt running
  work.
- The pipeline shows it as a CI Repair card ("Repair CI on <default branch>"
  with the triggering commit) linking the failing runs instead of an Issue.

## Triggering

One rule, evaluated on every Repository CI Gate observation including the
first after startup: start a CI Repair Work Item when automatic repair is on,
the Repository is not Paused, a selected CI Gate Definition has a failure newer
than the **CI Repair Baseline**, and no CI Repair Work Item for the Repository
is unfinished.

- **Earliest signal.** On GitHub the first failed job of an in-progress run
  counts as the failure; the gate closes on the same signal, so ordinary work
  stops being admitted at the same time. GitLab and Azure DevOps use the
  terminal run until job-level observation is implemented there.
- **One at a time.** Any unfinished CI Repair Work Item, including Needs Human
  or Paused, blocks another. The operator Retries or Resets it.
- **Baseline.** After a CI Repair Work Item's PR merges, the baseline becomes
  the CI run on that merge commit; that run or a later one failing starts a new
  repair. After a No-Change Outcome the baseline becomes the newest run
  observed at completion; a harness rerun is newer, so a repeat failure
  triggers again. After Abandon or Reset the baseline does not move, but
  automatic repair waits for a failure newer than the one that triggered the
  abandoned Work Item, so a human-closed PR does not loop.
- **New failures while in flight** are not passed to the running repair; the
  baseline rule picks up anything still red after it ends.
- **Manual start.** "Start CI Repair" creates the same Work Item while the gate
  is Closed and no CI Repair Work Item is unfinished, regardless of the setting
  and of Paused.

## Settings

The automatic-repair checkbox moves from Repository options into the CI Gate
section, in its own subsection below the CI Gate Definition list, and stays off
by default. It is disabled when no CI Gate Definition is selected.

## Trade-off

The repair loses ADR 0074's broad authority (infrastructure, credentials,
repository settings) and its single long-lived session; a repair needing those
ends in Needs Human. In exchange it is visible, reviewable, and supervised like
any other Work Item, and the CI-specific machinery shrinks to a trigger rule
and a baseline.
