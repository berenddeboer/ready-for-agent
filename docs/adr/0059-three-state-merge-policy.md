---
status: accepted
amends:
  - 0014
  - 0015
  - 0017
  - 0025
  - 0028
  - 0040
  - 0054
  - 0055
---

# Three-state Merge Policy with live inherit and Always `no_checks` carve-out

Repository settings and Implement With speak one three-state **Merge Policy**
(`off` / `classify` / `always`) instead of a boolean Auto-merge setting. A
Work Item has a nullable **Work Item Merge Policy** pin; `null` inherits the
live Repository Merge Policy at merge-routing time, and a concrete pin is the
effective policy regardless of later Repository flips. **Auto-merge** survives
only as Implement All with Auto-merge and means Always.

Always skips Classify only. After the Check-Start Deadline, `no_checks` is
green for Always and not for Classify. Pending, failed, and Expected checks,
merge conflicts, and Forge refusal still block. Implement Now, Queue, and
Repository Intake leave the pin unset; Implement With always writes a pin when
options are present.

This reverses ADR 0040's "unconditional merge is not a Repository setting"
(Repository `always` is now a live default; Always is still the Work Item pin)
and ADR 0054's "Implement With checkbox is not Merge Mode Always" (Implement
With `always` is that pin). ADR 0055 remains the rule for Classify and for
every non-`no_checks` aggregate.

## Considered Options

A fourth stored "yolo" value, or treating Always as a second boolean beside
Classify, would revive the Auto-merge naming mess and invent a second Always.
One three-state policy, with inherit-unless-pinned, is the smaller rule.

## Consequences

- Effective Always has one meaning whether it came from a live Repository
  Merge Policy, an Implement With pin, or Implement All with Auto-merge.
- The ontology no longer treats Repository Auto-merge and Merge Mode Always
  as disjoint: they are the same Always when the effective policy is `always`.
