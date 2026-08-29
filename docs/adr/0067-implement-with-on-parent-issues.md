---
status: accepted
amends:
  - 0052
  - 0054
---

# Implement With on Parent Issues

Implement With is allowed on a Parent Issue. It is the same command as on a leaf: one Explicit Work Item Execution Profile and a concrete Work Item Merge Policy pin, pre-filled from the Repository. It does not create a parent Work Item. Enrollment is the same atomic snapshot as Implement All with Auto-merge; new child Work Items get the profile and pin, adopted unfinished ones get the pin only.

Implement All with Auto-merge stays the one-click Always path with repository defaults and no dialog. Parent Implement With omits Implement Locally so a bulk start can move through many children without N inspection pauses. The parent menu offers `Implement all with auto-merge` then `Implement all with...`; the dialog title is `Implement all with...` with Implement / Cancel.

This supersedes ADR 0052's rejection of custom selection on parent paths. ADR 0054 still holds for Queue, Repository Intake, and parent Implement All: those commands do not gain profile, pin, or pause options.

## Considered Options

Folding the dialog into Implement All, or replacing that command, would make every parent start a form and destroy the Always one-click. A boolean Auto-merge checkbox cannot express Classify. Treating the parent as a work unit would overturn "only Leaf Issues are worked directly."

## Consequences

- Always is available on a parent both as Implement All with Auto-merge and as Implement With Merge Policy `always` plus an explicit profile.
- In-flight children are not Reset to apply a new profile.
