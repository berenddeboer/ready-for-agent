---
status: proposed
amends:
  - 0070
---

# Each Issue Tracker kind describes its own behaviour in one place

ADR 0070 made issue tracking configurable independently of repository
hosting and delivered Linear as the first Issue Tracker only kind. Linear
was wired in as a special case: the lifecycle asks "is this Linear" at
sixteen sites in four files and compares against the literal `linear`
at about twenty more (the reconciler, the GraphQL API, settings validation, the
settings screen). Those sites express seven behaviours that every tracker
kind has an answer to: which service discovers and mutates Issues, how
Implement presents the Issue to the agent, what the Pull Request body
references and whether it may close the Issue, which Lifecycle Step follows
a confirmed merge, which relevance policy applies, whether polling may start
without a credential, and which Repository settings are valid. A second
tracker-only kind (fp, ADR 0070's next tracker) added the same way is about
forty more branch points, and a kind added to the vocabulary without an
implementation compiles and misbehaves silently: it falls into the Forge
path, writes `Closes #n` for an Issue that is not on the Forge, and never
starts polling.

This ADR decides that each Issue Tracker kind describes those behaviours in
one place, and that the code that needs them either reads that description
or dispatches on the kind exhaustively. A kind without a description does
not compile; a kind whose description still lacks a behaviour cannot be
made selectable without a compile error; and a site that switches on the
kind names every kind. A site that depends on the hosting Forge rather than
the tracker, or whose source text an existing test pins, keeps its check
and is named in the change that introduces the description. GitHub, GitLab, Azure DevOps and Linear move behind that
description with no change in behaviour; every existing suite passes
unchanged. Three consequences of ADR 0070 that Linear left implicit become
explicit in the description:

- **A tracker kind may need no credential.** The polling activation, the
  credential probes and the helper-process self-spawn exist to keep a
  Forge or Linear token out of the harness process and out of an agent's
  reach. A kind whose identity is the operator's login on the machine (fp)
  has nothing to protect; its description says so, and polling starts for
  such a Repository without a credential probe. The credential path stays
  exactly as it is for the kinds that have a token.
- **Issue identity is the Issue Display Identifier everywhere the harness
  names things.** Implement's precondition of a positive integer issue
  number, and the numeric segment of branch names
  (`rfa/<slug>/<number>/<work-item>`) and worktree directories
  (`<number>-<work-item>`), are the last places a Forge integer is assumed.
  Linear passes them only because its Issues carry a team-local number. The
  segment is derived from the Issue Display Identifier through the existing
  sanitiser for every kind; for the Forge kinds the display identifier is the
  issue number, so their names are byte-identical and pinned by tests. Implement
  requires an Original Issue Source, not a number. The historical GraphQL
  `Int!` fields stay as ADR 0070's implementation left them. This part is
  delivered with fp's identity work, after the description lands; the
  behaviour-preserving change below does not touch it.
- **Tracker-specific Repository settings follow the Linear precedent**:
  named columns and fields per kind, validated by that kind's description,
  visible in the settings screen when that kind is selected. A tracker kind
  is available for any hosting Forge unless its description restricts it;
  the GitHub-only rule stays a Linear fact, not a rule of the model.

## Considered Options

Adding fp as a third branch at every site was rejected: it doubles the
sites, and the next kind (and the next reviewer) has no way to know where
the answers live or which one was forgotten. Keeping "Linear" as the name of
the tracker-only path and treating fp as "Linear with a different service"
was rejected: the two differ in identity, credential and presentation, and
the name would lie in every log line. Allocating a harness number to fp
Issues (mirrored into fp as a property) to satisfy the integer assumptions
was rejected: ADR 0070 made identity tracker-native, the harness already
stores native and display identifiers on every Issue and Work Item, and the
number would mean nothing to anyone; the assumptions are the leftover, not
the missing number. A single configuration document per tracker kind instead
of named columns was considered and deferred: it is the better shape for a
fifth kind, and a worse one for reading the Linear settings that already
exist; nothing in this ADR prevents it later.

## Consequences

- One behaviour-preserving change lands first, before any fp behaviour: the
  description type, one entry per existing kind, and the dispatch at each
  of the sites above. It is reviewed on its own, and its evidence is the
  unchanged suites of the four kinds plus the typecheck itself: the
  description table and its reader refuse a kind without a description,
  and a selectable kind without every behaviour.
- fp then fills its description in the following changes, one behaviour at a
  time, and the compiler names what is still missing.
- The Work Item lifecycle, the state machine and the Step Run reason codes
  are unchanged; only where the lifecycle asks "which tracker" changes.
- The glossary is unchanged by this ADR. The Repository Settings entry is
  amended when the fp settings land, in the same way the Linear settings
  amended it.
