# Issue tracker: Linear

Specs, implementation tickets, and wayfinding maps for this repository live in
Linear. GitHub hosts the code and pull requests for
`berenddeboer/ready-for-agent`; the Git remote does not determine the issue
tracker. This routing applies to `/to-spec`, `/to-tickets`, `/triage`,
`/wayfinder`, and any other workflow that publishes or updates tickets.

## Access and destination

Destination: Linear workspace `berenddeboer`, team **Berend de Boer** (`BER`),
project **ready-for-agent**. The local `LINEAR_API_KEY` environment variable
provides API access when no Linear tool integration is available; send it in
the Authorization header to `https://api.linear.app/graphql` without printing
or storing the credential.

Use an available authenticated Linear integration or API client. Discover its
supported operations before invoking them. Resolve the Ready for Agent project
and owning team from Linear or the Repository's configured Issue Tracker
mapping; verify the destination before creating issues. If access is unavailable
or the team/project cannot be identified unambiguously, ask the user for the
missing access or destination. Do not create GitHub issues as a fallback.

## Conventions

- **Create a spec or ticket:** create a Linear issue in the resolved team and
  project. Follow the invoking skill's content template.
- **Read a ticket:** resolve its Linear identifier or URL and read its full
  description, comments, labels, status, parent, and blocking relationships.
- **List tickets:** query Linear, scoped to the team/project and relevant
  status, labels, parent, or assignee.
- **Comment or update:** use the corresponding Linear operation and preserve
  unrelated description content, labels, and relationships.
- **Triage labels:** use the vocabulary in `docs/agents/triage-labels.md` and
  resolve the matching Linear labels. Fully specified, approved specs and
  tickets receive `ready-for-agent` as directed by their publishing skill.
- **Complete a ticket:** use the owning team's appropriate completed workflow
  status and record the outcome. Cancellation is distinct from completion.
- **References:** publish the returned Linear identifier and URL. Link relevant
  GitHub PRs to Linear issues; use explicit URLs for historical GitHub issues
  rather than treating a bare GitHub number as a new Linear ticket.

## Parent and blocking relationships

Publish a spec as the parent Linear issue and implementation tickets as native
sub-issues. Publish blockers before dependants, then create native Linear
blocking relationships. A parent relationship describes scope; a blocking
relationship describes execution order. Verify both after publishing.

Preserve the parent's title, description, labels, and status when publishing
child tickets, except for the relationships required by the invoking skill.
If the available integration cannot create a required relationship, report the
limitation and include explicit Linear links in the ticket descriptions rather
than claiming the native relationship exists.

## Skill translations

- **"Publish to the issue tracker":** create a Linear issue.
- **"Fetch the relevant ticket":** read the Linear issue and its comments.
- **"Create child tickets":** create Linear sub-issues with native blockers.
- **"Apply a triage label":** apply the matching Linear label.

## Wayfinding operations

- **Map:** one Linear issue labelled `wayfinder:map`, holding Notes,
  Decisions-so-far, and Fog.
- **Child ticket:** a native sub-issue of the map, labelled
  `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`).
- **Blocking:** native Linear issue relations, with explicit linked blockers
  in the description when native relations cannot be created.
- **Frontier:** the map's unfinished, unassigned children whose blockers are
  completed; work in the map's declared order.
- **Claim:** assign the selected ticket to the driving developer.
- **Resolve:** comment with the outcome, set the appropriate completed status,
  and append a short finding and Linear link to the map's Decisions-so-far.

## Pull requests

**PRs as a request surface: no.** Use `gh` for GitHub PR creation, review,
checks, and merging. Use Linear for the associated spec and tickets. Existing
GitHub issue URLs remain readable historical references; moving them to Linear
is a separate migration, not implicit in reading or linking them.
