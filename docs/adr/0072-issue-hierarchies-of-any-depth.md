---
status: proposed
amends:
  - 0005
  - 0006
  - 0040
  - 0067
---

# A Supported Issue Hierarchy may be any depth; relevance stays a direct-parent rule

ADR 0005 limits a Supported Issue Hierarchy to a root Issue with optional
direct children and declares a hierarchy that contains a grandchild
unsupported in its entirety. That limit is not what the harness evaluates.
The Relevant Issue projection decides per Issue: an open root is relevant, a
child is relevant when its direct parent is open and Ready-labeled, and only
Leaf Issues are worked (ADR 0006). The depth limit is computed separately,
inside the GitHub adapter, which reads each Issue's parent and grandparent,
marks any Issue with a grandparent or with nested sub-issues as unsupported,
and then invalidates its whole root. The Linear adapter, delivered under ADR
0070, marks every hierarchy as supported and reads one parent level, so a
Linear leaf at any depth is already worked when its direct parent is open and
Ready-labeled. GitHub itself allows up to eight levels of nested sub-issues,
and Linear and fp nest sub-issues as well. Teams plan at three levels (an
initiative, its epics, their tasks) and today have to flatten to use the
harness at all.

This ADR makes the definition match the evaluation. A Supported Issue
Hierarchy is any depth, wholly contained in one Repository. Relevance keeps
its per-Issue rule and gains no ancestor walk: a root Issue is relevant when
it is open; a non-root Issue is relevant when its direct parent is open and
Ready-labeled; only Leaf Issues are worked. The Ready label is what admits an
Issue at every level, so an operator who wants the leaves of a deep tree
worked labels each parent on the path, and an unlabeled or closed
intermediate parent stops its own subtree and nothing else. A cross-Repository
relationship still makes the hierarchy unsupported in its entirety.

Consequently the vocabulary changes in two places and nowhere else. A Parent
Issue is any Issue with one or more direct children, no longer necessarily a
root, so an Issue may be both a Child Issue and a Parent Issue. A Child Issue
may have children of its own. Leaf Issue, Standalone Issue, and Root Issue are
unchanged. Implement All with Auto-merge and Implement With on a Parent Issue
(ADR 0040, ADR 0067) enroll the parent's direct Leaf children and nothing
deeper; a direct child that is itself a Parent Issue is organizational context
and is skipped, not recursed into. Today those commands reject the whole
parent when any direct child has children of its own, because such a
hierarchy was unsupported; under this ADR that rejection becomes a skip of
that child, and the enrollment stays atomic over the leaf siblings.

## Considered Options

Keeping the two-level definition and flattening every deeper tree was
rejected: the harness already evaluates one level at a time, so the limit
buys no simplicity in the predicate, and it forces every team with an
initiative level to restructure a live tracker before the harness sees any of
its work. Applying the new definition only to Issue Tracker only kinds and
leaving GitHub at two levels was rejected because it would make the
definition depend on the tracker while the evaluation does not, and because
GitHub supports the nesting natively. Requiring every ancestor, not just the
direct parent, to be open and Ready-labeled was rejected: it needs the
adapter to fetch and the projection to store the whole ancestor chain for
every Issue, while the direct-parent rule composes to the same effect when
each level is labeled, and it gives an operator a per-subtree switch.
Recursing Implement All into nested parents was deferred, not rejected; it is
a separate command decision with its own atomicity questions.

## Consequences

- One visible behaviour change, gated by the Ready label: in a GitHub
  Repository, a Ready-labeled leaf at depth three or more whose direct parent
  is open and Ready-labeled was previously ignored together with its whole
  root, and becomes a Relevant Issue. Repositories whose hierarchies are at
  most two levels, and every GitLab, Azure DevOps, and Linear Repository,
  behave exactly as before.
- The GitHub adapter stops reading grandparents and nested sub-issue pages
  for depth detection and stops invalidating roots for depth; it keeps the
  cross-Repository check. The Relevant Issue predicate, the Issue store, the
  Work Item lifecycle, and the ontology's `RelevantIssue` and `LeafIssue`
  class expressions are unchanged; `isInSupportedIssueHierarchy` keeps its
  meaning and is simply true more often.
- The glossary entries Supported Issue Hierarchy, Parent Issue, and Child
  Issue are amended ontology-first with CONTEXT.md parity, and the sentence
  in ADR 0005 that omits "deeper-than-one-level hierarchies" is superseded by
  this ADR.
- Tests that pin the exclusion of a grandchild flip to pin its inclusion under
  a labeled open parent and its exclusion under an unlabeled or closed one;
  the cross-Repository exclusion tests are unchanged.
- Implement All with Auto-merge and Implement With gain the skip of a direct
  child that is itself a Parent Issue, with the parent-level guard that
  rejects "grandchildren" removed and its test flipped. A parent whose direct
  children are all Parent Issues has nothing to enroll and is reported as
  such.
- The fp Issue Tracker (a separate proposal) relies on this ADR for the
  three-level boards it serves; it needs nothing beyond what Linear already
  gets from the direct-parent rule.
