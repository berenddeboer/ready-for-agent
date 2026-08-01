# Kanban Pipeline View

## Purpose

The Kanban Pipeline is an alternate Harness work view for an operator who
needs to understand flow at a glance: what is waiting, being built, under
review, in the PR path, blocked, or merged.

The board is the home page (`/`). Legacy `/kanban` bookmarks redirect to `/`.
With zero repositories configured, `/` shows the add-repo blank slate instead of
an empty pipeline.

The board is a projection of existing Work Items. It does not introduce a
second workflow or mutate lifecycle state.

## Operator Question

Repository management lives on `/repos`. The board should make this question
fast to answer:

> Where is work accumulating, and which work needs intervention now?

This makes the view especially useful during active delivery periods, when a
list ordered by recency does not show congestion or handoffs clearly.

## Board Model

The board has six ordered lanes:

| Lane | Meaning | Derived from |
| --- | --- | --- |
| Queue | Work cannot begin yet: waiting for blockers or a worker slot. | `WAITING_FOR_BLOCKERS`, `WAITING_FOR_WORKER_SLOT` |
| Build | Startup and implementation work (including queued later Build steps). | `CREATE_WORKTREE`, `INSTALL_DEPENDENCIES`, `IMPLEMENT`, `ASSESS_CHANGES`, `PRE_COMMIT` |
| Review | Local review is in progress (including a queued Review step). | `REVIEW` |
| PR | Commit through cleanup on the pull-request path (including queued Watch and later PR steps). | `COMMIT`, `CREATE_PR`, `WATCH_PR_STATUS_CHECKS`, `RESOLVE_PR_MERGE_CONFLICT`, `INVESTIGATE_PR_STATUS_CHECKS`, `MARK_PR_READY_FOR_REVIEW`, `DECIDE_PR_MERGE`, `MERGE_PR`, `CLOSE_ISSUE`, `LOCAL_CLEANUP` |
| Attention | An operator or remediation decision is needed. | Failed, interrupted, needs-human statuses or states |
| Merged | The Work Item has reached a terminal successful or abandoned state. | Complete, succeeded, or abandoned statuses or states |

Lane assignment is a pure function of the current Work Item state and status.
Placement is driven by **lifecycle progress**, not scheduler status:

- Attention and Merged take precedence over every lifecycle lane.
- Queue is only for genuine blocked or not-admitted work. A `QUEUED` step run
  (status-check poll, agent turn, or later lifecycle step) stays in Build,
  Review, or PR according to its state.
- Once work has entered Build, Review, or PR, queued execution of a later step
  in that path must not return it to Queue or an earlier lane.

For example, a Work Item whose last step was Review but whose status is
`NEEDS_HUMAN` belongs in Attention. A Work Item in `WATCH_PR_STATUS_CHECKS`
with status `QUEUED` (pending poll cycle) stays in PR, not Queue.

## Layout And Visual Language

The prototype uses an industrial control-board language:

- Dense, six-column board with high-contrast lane headers.
- Fixed lane colors make the flow memorable: Queue yellow, Build blue, Review
  violet, PR green, Attention orange, and Merged black.
- Tickets use a narrow colored edge to retain their lane association while
  keeping title, repository, status, controls, session, and worktree visible.
- Empty lanes explicitly say `Lane clear`; an empty lane is operational
  information rather than unused space.
- The regular committed-pull-request totals remain above the board, so delivery
  throughput and in-flight flow are visible together.
- Repository management and intake live on `/repos`, not under the board.

The visual treatment follows the Interchange design system
(`docs/harness-design-system.md`) for tokens and type, implemented
**Tailwind-first** (`apps/harness/src/ui.ts` recipes; tokens in
`styles.css`). The board is a dense industrial control surface: a route line
of lane-colored roundels showing each lane’s work-item count, above flush
six-column lanes on a grey bed with ink gutters, full-width colored headers
(title only, same header height as before), and tickets sized to the
Completed archive type floor.

## Interaction Model

Sticky chrome under Merged-PR throughput always shows the primary Jobs
switcher:

1. **Pipeline** (`/`) — six lifecycle lanes.
2. **Repos** (`/repos`) — repository management.
3. **Completed** (`/completed`) — full completed-work archive with pagination.

Completed uses wider archive-style cards (journey legs, forge PR/MR badge,
full session id) in a responsive grid and keeps repository filters in the
sticky chrome.

There are no separate Working or Failed list tabs. Pipeline still assembles
tickets from the existing working, failed, and completed Work Item queries.

The existing arrow-key tab behavior, selected-tab ARIA semantics,
retry/reset/start/pause actions, Session usage dialog, issue links, and
pull-request links remain available.

Repository filters sit above the board:

- `All sources` shows every repository.
- A repository filter limits every lane and the Completed tab to that
  repository.
- Filter selection is local UI state and does not alter repository settings or
  the underlying queries.

Tickets remain sorted newest first within each lane. This gives recency without
destroying the flow grouping supplied by the board.

## Ticket lifecycle chips (lane-scoped collapse)

Kanban tickets reuse the Work Item lifecycle chip row, but **collapse earlier
lanes by default** so the card focuses on steps for the lane the ticket is in.
Completed archive cards use a related pattern: condensed BUILD / REVIEW / PR|MR
legs that expand to the same fine-grained lifecycle chips (ephemeral ▸ / ▾).

### Focus lane

- **Build / Review / PR:** focus = that lane’s phases (same grouping as board
  placement above).
- **Attention:** focus = the lifecycle lane the Work Item would occupy from
  state alone (Build, Review, or PR). Attention placement still wins for the
  column; chip focus follows lifecycle progress.
- **Queue:** no change (chips are usually absent).
- **Merged:** unchanged — no step chips; summary only.

### Earlier lanes

For each **earlier** lifecycle lane (Build → Review → PR order) that has at
least one chip, show one summary row instead of those chips:

- Collapsed: `▸ {Lane name}  {duration}`
- Expanded: `▾ {Lane name}  {duration}` plus that lane’s chips underneath

Rules:

- **Name + duration only** on the summary (no status tint, no per-step detail).
- **Duration** = sum of that lane’s chip `durationMs` values (skip nulls);
  format like chip durations. Not live-ticking.
- Expand/collapse is **per earlier lane**, independent, and **ephemeral**
  (local UI state; not persisted).
- Expanding a summary **replaces** the collapsed row with the header + chips
  for that lane; other earlier lanes stay summaries until expanded.
- **Current-focus-lane chips** are always fully listed after all earlier-lane
  blocks.
- Do **not** auto-expand an earlier lane because a chip there failed or needs
  human; Attention and the status badge carry alarm. Optional later: tint a
  summary when any chip in that lane is non-success.

### Phase grouping

Chip phases map to Build / Review / PR exactly as in the board model table
(including PR-path steps from Commit through local cleanup). The collapsed
GitHub status-checks phase counts as PR.

### Out of scope (v1)

- Persisted expand state, hover-only expand, or wall-clock span durations.
- Hiding in-lane chips (succeeded steps in the focus lane stay visible).

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

## Route Seam

Home (`/`) is a thin composition layer:

1. With zero repositories, render the shared add-repo blank slate.
2. With one or more repositories, render the committed pull-request totals and
   `KanbanJobsBoard` (pipeline lanes; Completed links to `/completed`).
3. Jobs switcher: Pipeline (`/`), Repos (`/repos`), Completed (`/completed`).
4. `/kanban` redirects to `/`. Repository management stays on `/repos`.

Shared pieces:

- `pipelineLaneFor(workItem)` and lane definitions.
- Board controls and responsive lane selector in `kanban-board.tsx`.
- Ticket component that composes existing Work Item actions and status UI.

## Acceptance Criteria

- Board placement never changes a Work Item, repository, or lifecycle state.
- Attention wins over lifecycle-step placement; terminal status wins over
  lifecycle-step placement.
- Queued status-check polls and other queued later steps stay in their
  lifecycle lane; only blockers / worker-slot holds appear in Queue.
- Every ticket preserves access to its existing operational actions.
- Pipeline and Completed remain available and keyboard accessible.
- Repository filtering applies consistently to both board and Completed list.
- Zero repositories → blank slate on `/`; one or more → board on `/`.
- Desktop shows all six lanes; mobile shows a selected lane without horizontal
  page overflow.
- No new polling or GraphQL contract is introduced.
- Lane classifier, tab keyboard behavior, filtering, and mobile lane selection
  are covered by tests.
- Kanban tickets collapse earlier-lane lifecycle chips into per-lane summary
  rows (name + summed duration); focus-lane chips stay expanded; expand state
  is local and ephemeral; Home chip rows are unaffected.
