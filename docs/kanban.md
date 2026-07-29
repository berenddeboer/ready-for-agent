# Kanban Pipeline View

## Purpose

The Kanban Pipeline is an alternate Harness work view for an operator who
needs to understand flow at a glance: what is waiting, being built, under
review, ready to ship, blocked, or complete.

It was prototyped in the `redesign/kanban-pipeline` branch. The prototype
demonstrates the interaction model and visual direction; it is not currently
part of the main Harness route tree.

The board is a projection of existing Work Items. It does not introduce a
second workflow, mutate lifecycle state, or replace the existing dashboard.

## Operator Question

The standard dashboard answers questions about repositories, settings, and
individual Jobs. The board should make this question fast to answer:

> Where is work accumulating, and which work needs intervention now?

This makes the view especially useful during active delivery periods, when a
list ordered by recency does not show congestion or handoffs clearly.

## Board Model

The board has six ordered lanes:

| Lane | Meaning | Derived from |
| --- | --- | --- |
| Queue | Work has not begun active lifecycle execution. | `QUEUED`, `WAITING_FOR_WORKER_SLOT` |
| Build | Active startup and implementation work is in progress. | `CREATE_WORKTREE`, `INSTALL_DEPENDENCIES`, `IMPLEMENT`, `ASSESS_CHANGES`, `PRE_COMMIT` |
| Review | A pull request or review/check handoff is in progress. | `REVIEW`, `WATCH_PR_STATUS_CHECKS`, `RESOLVE_PR_MERGE_CONFLICT`, `INVESTIGATE_PR_STATUS_CHECKS` |
| Ship | Work is beyond review but not terminal. | Any non-terminal lifecycle state not classified above |
| Attention | An operator or remediation decision is needed. | Failed, interrupted, needs-human statuses or states |
| Complete | The Work Item has reached a terminal successful or abandoned state. | Complete, succeeded, or abandoned statuses or states |

Lane assignment is a pure function of the current Work Item state and status.
The function must give Attention and Complete precedence over lifecycle-step
classification. For example, a Work Item whose last step was Review but whose
status is `NEEDS_HUMAN` belongs in Attention.

## Layout And Visual Language

The prototype uses an industrial control-board language:

- Dense, six-column board with high-contrast lane headers.
- Fixed lane colors make the flow memorable: Queue yellow, Build blue, Review
  violet, Ship green, Attention orange, and Complete black.
- Tickets use a narrow colored edge to retain their lane association while
  keeping title, repository, status, controls, session, and worktree visible.
- Empty lanes explicitly say `Lane clear`; an empty lane is operational
  information rather than unused space.
- The regular committed-pull-request totals remain above the board, so delivery
  throughput and in-flight flow are visible together.
- Repositories remain below the board as source and intake context.

The visual treatment may be adapted to the active Harness design system. The
essential design idea is the board structure, fixed lane identity, and compact
operator-facing ticket, rather than the prototype's exact palette or fonts.

## Interaction Model

The Jobs area has four tabs:

1. Pipeline is the default and renders the six lanes.
2. Working retains the existing active-work list.
3. Failed retains the existing failed-work list.
4. Completed last 24 h shows every work item completed in the rolling previous
   24 hours (no fixed item limit).

The existing arrow-key tab behavior, selected-tab ARIA semantics, Jobs collapse
control, retry/reset/start/pause actions, Session usage dialog, issue links,
and pull-request links remain available. Pipeline is an additional
presentation, not a reduced-action overview.

Repository filters sit above the board:

- `All sources` shows every repository.
- A repository filter limits every lane and every non-Pipeline tab to that
  repository.
- Filter selection is local UI state and does not alter repository settings or
  the underlying queries.

Tickets remain sorted newest first within each lane. This gives recency without
destroying the flow grouping supplied by the board.

## Responsive Behavior

Six simultaneously visible columns work on a desktop operator display but do
not fit a phone.

At a narrow viewport:

- Repository filters become a horizontal, touch-scrollable row.
- A six-lane selector appears as a three-column control grid.
- Only the selected lane is displayed at a time.
- Lane headers stop being sticky, avoiding nested scrolling and obscured ticket
  content.

The mobile selector must expose the selected lane with `aria-pressed`; the
desktop lanes should remain semantic labelled sections under a `Lifecycle
pipeline` region.

## Data And Implementation Boundaries

The board should reuse existing Harness data boundaries:

- Repository list from the existing repository query.
- Existing working, failed, and completed Work Item queries.
- Existing issue queries to enrich ticket titles and URLs.
- Existing Work Item controls, lifecycle-status presentation, Session usage
  dialog, copy control, and repository/action mutations.

The board should deduplicate Work Items assembled from the three list queries
by Work Item ID before assigning lanes. It should not create an additional
polling loop or a new server-side API solely for board placement.

Keep the lane classifier close to the board module and cover it with focused
tests. It is a presentation policy that will need deliberate updates if the
lifecycle gains new states.

## Proposed Route Seam

When adopted, introduce a dedicated `/kanban` route rather than changing the
current dashboard route by default.

The route should be a thin composition layer:

1. Render the existing application shell and settings control.
2. Render the committed pull-request totals.
3. Render a reusable `KanbanJobsBoard` over existing Work Item queries and
   actions.
4. Render existing repository cards below the board.

Extract reusable pieces rather than copying the current index route:

- `pipelineLaneFor(workItem)` and lane definitions.
- The board controls and responsive lane selector.
- A ticket component that composes existing Work Item actions and status UI.

The current dashboard and `/kanban` should share query functions and mutation
behavior, but may intentionally use different information hierarchy and visual
systems.

## Acceptance Criteria

- Board placement never changes a Work Item, repository, or lifecycle state.
- Attention wins over lifecycle-step placement; terminal status wins over
  lifecycle-step placement.
- Every ticket preserves access to its existing operational actions.
- Existing Working, Failed, and Completed views remain available and keyboard
  accessible.
- Repository filtering applies consistently to both board and list views.
- Desktop shows all six lanes; mobile shows a selected lane without horizontal
  page overflow.
- No new polling or GraphQL contract is introduced.
- Lane classifier, tab keyboard behavior, filtering, and mobile lane selection
  are covered by tests.
