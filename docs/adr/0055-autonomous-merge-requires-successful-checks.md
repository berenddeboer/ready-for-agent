---
status: accepted
amends:
  - 0017
  - 0028
  - 0040
---

# Autonomous merge requires a successful status-check aggregate

Harness-initiated pull request and merge request merge requires the Forge's
current aggregate status to be successful and non-empty, except for the
narrow Always `no_checks` carve-out in ADR 0059. Agent approval is necessary
for Classify but is not a substitute for external checks. This is a safety
property of Classify and of every non-`no_checks` aggregate, not a toggle
that Always can turn off for pending, failed, or Expected checks.

The invariant applies to Classify (live Repository Merge Policy `classify`,
or a Work Item Merge Policy pin of `classify`) and to every non-`no_checks`
aggregate on Always. Effective `off` remains non-autonomous. Always still
skips only Classify.

Watch still uses the Check-Start Anchor and Check-Start Deadline. Before the
deadline, `no_checks` and GitHub `EXPECTED` continue waiting for executions to
appear. At or after the deadline, Classify and `off` still do not treat
`no_checks` or `EXPECTED` as green: the Work Item enters Needs Human with
Step Run reason `missing_successful_checks` and an operator-facing note that
no successful checks were reported (or that a required context stayed
`EXPECTED`). Always treats post-deadline `no_checks` as green and advances to
Merge PR; `EXPECTED`, pending, and failed still block Always (ADR 0059). When
`waitForReadyForReviewChecks` disables the Ready-Phase Status Check Round,
Classify with `no_checks` or `EXPECTED` still enters Needs Human, while Always
with post-deadline `no_checks` advances to Merge PR. GitLab `no_checks` from
an absent or non-qualifying head pipeline follows the same Always carve-out.

The Needs Human handoff is retryable: Retry returns to Watch PR Status Checks
without discarding the Work Item, Session, worktree, branch, or PR. Once a
successful aggregate is observed, or Always observes post-deadline
`no_checks`, normal autonomous routing may resume. A human may still merge
the pull request on the Forge.

Merge PR revalidation is fail-closed except for Always + `no_checks`. An
`EXPECTED`, pending, or failed aggregate is not accepted as green. Pending and
failed aggregates still return to Watch as Merge Revalidation Outcomes. An
absent or `EXPECTED` aggregate produces the established missing-check Needs
Human handoff rather than issuing the Forge merge mutation, except that
Always after the Check-Start Deadline accepts `no_checks`.

## Consequences

- Absence of CI is no longer equivalent to successful CI for Classify.
- Repositories without checks can Always-merge after the Check-Start Deadline;
  Classify still requires a human when there is no successful aggregate.
- ADR 0028's statement that `no_checks` and `EXPECTED` no longer block after
  the deadline is limited to startup waiting; only Always + `no_checks`
  satisfies autonomous merge (ADR 0059).
- ADR 0040's Always still skips only Decide PR Merge; it cannot bypass
  pending, failed, or Expected checks.
- ADR 0017's merge revalidation treats a null check rollup as green only for
  Always after the Check-Start Deadline.
