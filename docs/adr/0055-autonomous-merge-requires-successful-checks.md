---
status: accepted
amends:
  - 0017
  - 0028
  - 0040
---

# Autonomous merge requires a successful status-check aggregate

Harness-initiated pull request and merge request merge requires the Forge's
current aggregate status to be successful and non-empty. Agent approval is
necessary for ordinary Auto-merge but is not a substitute for external checks.
This is an unconditional safety property, not a Repository or Work Item setting.

The invariant applies to every autonomous merge route: live Repository
Auto-merge with no Work Item override, a true Work Item Auto-merge override,
and Merge Mode `always`. A false Work Item override remains non-autonomous
even when Repository Auto-merge is enabled; ordinary Work Items without an
autonomous path keep today's human-merge Decide PR Merge behavior.

Watch still uses the Check-Start Anchor and Check-Start Deadline. Before the
deadline, `no_checks` and GitHub `EXPECTED` continue waiting for executions to
appear. At or after the deadline they no longer authorize autonomous progress:
the Work Item enters Needs Human with Step Run reason
`missing_successful_checks` and an operator-facing note that no successful
checks were reported (or that a required context stayed `EXPECTED`). When
`waitForReadyForReviewChecks` disables the Ready-Phase Status Check Round,
the same autonomous path with `no_checks` or `EXPECTED` enters Needs Human
instead of Decide PR Merge or Merge PR. GitLab `no_checks` from an absent or
non-qualifying head pipeline has the same outcome.

The Needs Human handoff is retryable: Retry returns to Watch PR Status Checks
without discarding the Work Item, Session, worktree, branch, or PR. Once a
successful aggregate is observed, normal autonomous routing may resume. A
human may still merge the pull request on the Forge.

Merge PR revalidation is fail-closed. An absent/null, `EXPECTED`, pending, or
failed aggregate is not accepted as green. Pending and failed aggregates still
return to Watch as Merge Revalidation Outcomes. An absent or `EXPECTED`
aggregate produces the established missing-check Needs Human handoff rather
than issuing the Forge merge mutation.

## Consequences

- Absence of CI is no longer equivalent to successful CI for autonomous merge.
- Repositories without checks remain usable: their pull requests must be
  reviewed and merged by a human.
- ADR 0028's statement that `no_checks` and `EXPECTED` no longer block after
  the deadline is limited to startup waiting; they do not satisfy autonomous
  merge.
- ADR 0040's Merge Mode `always` still skips only Decide PR Merge; it cannot
  bypass the external-check gate.
- ADR 0017's merge revalidation no longer treats a null check rollup as green.
