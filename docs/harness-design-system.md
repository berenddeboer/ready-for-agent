# Harness Design System — "Interchange" (de-trained)

Implementation-handoff spec for the unified Harness operator UI, chosen and
iterated on the [Unified industrial design](https://github.com/berenddeboer/ready-for-agent/issues/689)
wayfinder map:

- Direction: **D — Interchange as the visual base, de-trained** (per
  [#695](https://github.com/berenddeboer/ready-for-agent/issues/695)):
  stark station-white surfaces, lanes as saturated lane-color nameboards with
  roundels, B's flush stamped-plate nav, plain words, no transit jargon, no
  Network Key footer, old-dashboard simplicity.
- Archive surface blend approved per
  [#698](https://github.com/berenddeboer/ready-for-agent/issues/698).

**Sources of truth** (approved prototypes; this document transcribes them):

- Board/homepage:
  [`apps/harness/prototypes/wayfinder-693-direction-d.html`](https://github.com/berenddeboer/ready-for-agent/blob/prototype/wayfinder-693-direction-d/apps/harness/prototypes/wayfinder-693-direction-d.html)
  on branch `prototype/wayfinder-693-direction-d`
- Completed page (two-theme token layer, stamped-plate nav):
  [`apps/harness/prototypes/wayfinder-698-completed-page.html`](https://github.com/berenddeboer/ready-for-agent/blob/prototype/wayfinder-698-completed-page/apps/harness/prototypes/wayfinder-698-completed-page.html)
  on branch `prototype/wayfinder-698-completed-page` (+ light/dark screenshots
  beside it)

Where this spec and a prototype disagree, the prototype wins for surfaces it
renders; this spec wins for everything else (the prototypes cover only the
homepage and the completed page).

**Scope.** Visual treatment only. No board structure or behavior changes, no
new features beyond the Queue discoverability hint. Implementation is a
separate effort; this document is its contract.

---

## 1. Principles

1. **Lane color is identity.** The six fixed lane colors carry all pipeline
   meaning — on nameboards, roundels, ticket edge bars, and journey-leg chips.
   Nothing else in the UI is saturated.
2. **No grey fills, no warm paper, no serif.** Lanes are open white platforms;
   lane color appears on the nameboard, not as a lane background wash.
3. **Hard borders, flush surfaces.** 2px or 1.5px solid ink borders. No
   border-radius (except roundels). No offset or drop shadows; depth is inset
   only (plate bevels, ticket lane bars).
4. **The transit metaphor is visual, never verbal.** Route lines, roundels,
   and nameboards are allowed; the words are always plain ("Feed the queue",
   never "Transfer"). See §10 Voice.
5. **Two themes from day one.** One token set, `[data-theme]` overrides, lane
   colors invariant across themes. No dark-mode retrofit.
6. **Old-dashboard simplicity.** Merged-PR throughput stays front and center
   above the board; chrome stays out of the operator's way.

## 2. Tokens

### 2.1 Lane colors (fixed pipeline identity — theme-invariant)

| Token | Value | On-lane ink | Lane |
| --- | --- | --- | --- |
| `--lane-queue` | `#ffd21c` | `#151515` | 01 Queue |
| `--lane-build` | `#1976d2` | `#ffffff` | 02 Build |
| `--lane-review` | `#7654b5` | `#ffffff` | 03 Review |
| `--lane-pr` | `#168b62` | `#ffffff` | 04 PR |
| `--lane-attention` | `#ff4d1c` | `#151515` | 05 Attention |
| `--lane-merged` | `#151515` | `#ffffff` | 06 Merged |

Lane colors never change between themes. They map 1:1 to
`PIPELINE_LANES` in `apps/harness/src/pipeline-lanes.ts`; that module stays
the behavioral source of truth, and the token layer mirrors it.

### 2.2 Neutrals and roles (per theme)

Light (`:root`, `[data-theme="light"]`):

| Token | Value | Used for |
| --- | --- | --- |
| `--paper` | `#ffffff` | page background |
| `--panel` | `#ffffff` | card/archive bodies |
| `--ink` | `#151515` | text, borders, route line |
| `--ink-dim` | `#4a4a4a` | secondary text, chip text |
| `--ink-faint` | `#8b8b8b` | meta text, empty states |
| `--line-soft` | `rgb(21 21 21 / 0.30)` | secondary borders |
| `--line-ghost` | `rgb(21 21 21 / 0.12)` | hairlines, ghost borders |
| `--signal` | `#ffd21c` | accent: selection, hover, kicker tags (= Queue yellow) |
| `--merged-halo` | `transparent` | halo behind Merged black (not needed on white) |

Dark (`[data-theme="dark"]`):

| Token | Value |
| --- | --- |
| `--paper` | `#15181b` |
| `--panel` | `#1c2024` |
| `--ink` | `#f2f3f1` |
| `--ink-dim` | `#c6cac8` |
| `--ink-faint` | `#7f8583` |
| `--line-soft` | `rgb(242 243 241 / 0.32)` |
| `--line-ghost` | `rgb(242 243 241 / 0.14)` |
| `--signal` | `#ffd21c` (unchanged) |
| `--merged-halo` | `rgb(242 243 241 / 0.85)` |

**The Merged halo rule.** Merged black `#151515` vanishes on dark paper, so
every Merged-black element — roundel, nameboard edge, ticket line bar, stamp,
PR badge — gains a white hairline halo in dark mode (`--merged-halo`). In
light mode the halo token is transparent. This is the one per-theme
compensation; everything else is a straight token swap.

### 2.3 Masthead (dark supergraphic band in **both** themes)

| Token | Light | Dark |
| --- | --- | --- |
| `--mast-bg` | `#101314` | `#000000` |
| `--mast-ink` | `#ffffff` | `#ffffff` |
| `--mast-dim` | `#b9b9b9` | `#b9b9b9` |
| `--mast-faint` | `#7c7c7c` | `#7c7c7c` |
| `--mast-plate` | `#2b2f33` | `#232629` |
| `--mast-plate-hover` | `#3a4046` | `#32373b` |
| `--mast-plate-ink` | `#d7dbd9` | `#d7dbd9` |
| `--mast-plate-rivet` | `rgb(0 0 0 / 0.6)` | `rgb(0 0 0 / 0.65)` |
| `--mast-plate-hi` | `rgb(255 255 255 / 0.14)` | `rgb(255 255 255 / 0.12)` |
| `--mast-plate-active` | `#e8ece9` | `#e8ece9` |
| `--mast-plate-active-ink` | `#101314` | `#101314` |
| `--mast-plate-active-rivet` | `rgb(16 19 18 / 0.5)` | `rgb(16 19 18 / 0.5)` |

### 2.4 Stamped plates on paper

| Token | Light | Dark |
| --- | --- | --- |
| `--plate` | `#dfe4e1` | `#2b2f33` |
| `--plate-hover` | `#cfd6d2` | `#3a4046` |
| `--plate-ink` | `#23282b` | `#d7dbd9` |
| `--plate-rivet` | `rgb(16 19 18 / 0.55)` | `rgb(0 0 0 / 0.6)` |
| `--plate-hi` | `rgb(255 255 255 / 0.65)` | `rgb(255 255 255 / 0.14)` |
| `--plate-lo` | `rgb(16 19 18 / 0.12)` | `rgb(0 0 0 / 0.35)` |

### 2.5 PR badge

| Token | Light | Dark |
| --- | --- | --- |
| `--prbadge-bg` | `#151515` | `#151515` |
| `--prbadge-ink` | `#ffffff` | `#f2f3f1` |
| `--prbadge-border` | `transparent` | `var(--merged-halo)` |

Hover: fill becomes `--lane-pr` (white text), in both themes.

### 2.6 Typography

| Token | Stack |
| --- | --- |
| `--font-display` | `"Inter Tight", "Helvetica Neue", Helvetica, Arial, sans-serif` |
| `--font-mono` | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

The old serif display face is gone everywhere — headings, stats numerals, and
repo titles all use the display grotesque.

**Usage rules:**

- Display font for headings, titles, stats numerals, body copy, lede text.
- Mono for micro-labels, meta lines, kickers, tags, chips, badges, buttons,
  table values — always uppercase with letter-spacing (0.04em–0.28em by size;
  smaller = wider tracking).
- Numerals in stats and counts: `font-variant-numeric: tabular-nums`.
- `font-synthesis: none`; `text-rendering: optimizeLegibility` on body.

**Scale** (board density vs. relaxed surfaces — the archive relaxes off the
board's density per #698):

| Slot | Size / weight | Where |
| --- | --- | --- |
| Masthead wordmark | `clamp(2rem, 4.2vw, 3.1rem)` / 800, uppercase, ls −0.015em | brand |
| Page title | `clamp(1.7rem, 3.2vw, 2.4rem)` / 800, uppercase | page headers |
| Stats numeral | `clamp(2.1rem, 3vw, 2.9rem)` / 700, tabular | merged-PR stats |
| Lane nameboard / count | 1.05rem / 800 uppercase · 1.5rem / 800 | board + archive slab |
| Card title (board) | 0.9rem / 500 | job tickets |
| Card title (relaxed) | 1.06rem / 600 | archive rows, repos cards |
| Body / lede | 0.92–0.98rem / 400–500 | banners, descriptions |
| Meta (relaxed) | 0.7rem mono uppercase | archive meta |
| Meta (board) | 0.58–0.62rem mono uppercase | repo lines, runtime, via |
| Chips / legs (relaxed) | 0.62rem mono | archive legs |
| Chips / legs (board) | 0.56rem mono | board legs, tags |

**Type floor.** The Ledger-era "no sub-`text-xs` sizes" rule is superseded:
dense board chrome floors at **0.56rem** mono; relaxed surfaces floor at
**0.62rem** mono. Body copy never goes below 0.82rem. (Approved via the two
prototypes.)

### 2.7 Borders, radius, shadows

- **2px solid `var(--ink`)**: nameboards, banners, stats slab, tabs, primary
  plates, queue-intake plate, dialog panels, menu panels.
- **1.5px solid `var(--ink`)**: cards (tickets, archive rows, repo cards),
  chips, legs, stamps, secondary buttons, fields.
- **1px / hairline**: dividers on dark slabs (`rgb(255 255 255 / 0.14–0.22)`),
  `--line-soft` / `--line-ghost` separators, filter buttons.
- **Radius: none.** The only circles are roundels and nav dots
  (`border-radius: 50%`).
- **Shadows: inset only.** Plate bevel
  (`inset 0 1px 0 var(--plate-hi), inset 0 -2px 0 var(--plate-lo)`), ticket
  lane bar (`inset 6px 0 0 var(--lane)`), active-filter underline
  (`inset 0 -3px 0 var(--ink)`). **No offset block shadows and no drop
  shadows anywhere** — the Ledger `5px 5px 0` / `2px 2px 0` blocks and the
  menu drop shadow are gone; elevation reads through the hard border.

### 2.8 Spacing

Named slots (rem), transcribed from the prototypes:

| Slot | Value | Where |
| --- | --- | --- |
| page padding | 1.6–1.8 / 2.2 (y/x); 1.2–1.3 / 1.4 ≤900px | `.page` |
| masthead padding | 1.5 / 2.2; 1.2 / 1.4 ≤900px | `.mast` |
| lane gap | 0.9 | network grid |
| platform padding / gap | 0.65 | lane body |
| card gap | 0.6 | archive body, rows |
| card padding | 0.55–0.7 (+0.95–1 left for lane bar) | tickets, rows |
| control gap | 0.3–0.55 | chips, legs, filters, nav plates |
| section rhythm | 1.5–1.7 top margin | controls, slabs |

### 2.9 Focus, selection, motion

- `:focus-visible`: 2px solid `var(--ink)`, offset 2px. On the masthead band:
  `var(--signal)`.
- `::selection`: `var(--signal)` background, `#151515` text (both themes).
- Transitions: 120ms ease on plate background/color only. Honor
  `prefers-reduced-motion` globally (existing base rule carries over).

## 3. Theme system

- One token set; `[data-theme="dark"]` overrides the neutral/masthead/plate
  groups on `<html>`. Lane colors and fonts live outside the themed blocks.
- Default follows `prefers-color-scheme`; a **theme-toggle plate** in the
  masthead nav flips light/dark (moon icon, label = target theme,
  `aria-pressed`). `?theme=light|dark` may pin a theme for sharing.
- The masthead band stays dark in both themes (§2.3).
- Dark-mode stats slab keeps the black departure-board treatment; light mode
  gets the lighter treatment (§4.2) — per #695.

## 4. Surfaces

### 4.1 Nav shell (every route)

**Masthead** — full-width dark supergraphic band (`--mast-bg`), flex with
brand left and nav right, items baseline-aligned.

- **Brand block**: mono kicker (`--mast-faint`, product · "Operator board" ·
  version in `--mast-dim`), wordmark link in display 800 uppercase white
  (hover: `--signal`), mono sub-line with live status fragment in `--signal`.
- **Primary nav** — B's flush stamped plates, replacing D's system-map stops:
  Home, Repos, Completed, Settings (button, `aria-haspopup="dialog"`), plus
  the theme-toggle plate. Plate anatomy (§5.3): 2px black border, rivet dots,
  mono uppercase 0.7rem/700, icon (0.9rem inline SVG) + label; active page =
  light plate (`--mast-plate-active` ink) with `aria-current="page"`.
- **Lane ribbon**: 0.4rem strip directly under the masthead — six equal
  segments in lane-color order. Purely visual, `aria-hidden`.
- **Not-found route**: standard panel + "Back home" link, same language.

### 4.2 Merged-PR stats (home, above board)

Old-dashboard simplicity: what we merged, front and center. Five quantities
(Today / Yesterday / This week / Last week / Two weeks ago).

- **Light theme — lighter treatment** (per #695): `--paper` panel, 2px ink
  border, header row with signal-yellow tag + "Merged PR throughput" + mono
  note; five cells divided by `--line-ghost` hairlines; ink tabular
  numerals, `--ink-faint` mono labels.
- **Dark theme — departure-board slab**: `--mast-bg` black panel with the
  same 2px `--ink` border (a light hairline frame in dark mode), same
  signal-tag header in `--mast-ink`; cells divided by white hairlines
  (`rgb(255 255 255 / 0.14)`); white tabular numerals, `--mast-dim` labels.
- Loading = five skeleton bars in panel tones; load failure = inline banner
  (§4.8) inside the panel.

### 4.3 Kanban board (home)

**Controls row** (above the network, on paper — no panel fill):

- **Tabs** (Pipeline / Completed 24 h · n): joined 2px ink-bordered buttons,
  −2px overlap; active = solid ink fill, white text. Arrow-key tab behavior
  and ARIA semantics unchanged.
- **Repository filters**: joined 1px `--line-soft`-bordered mono buttons;
  active = ink text, 700, `inset 0 -3px 0 var(--ink)` underline.
  Horizontal touch-scroll on mobile (existing behavior).

**The network** (desktop, >1500px): six-column grid; a 4px ink **route
line** runs column-centre to column-centre behind the roundels (visual motif
only, `aria-hidden`); each lane carries a **roundel** (2.1rem disc, lane
fill, 2px ink border, mono lane number) riding the line. Merged's black disc
gets a white border + ink outline so it reads on the black line.

≤1500px the route line is hidden and the roundel shrinks to a 1.4rem badge
pinned on the nameboard. ≤900px the existing single-lane mobile behavior
stays (lane switcher below) — this is a re-skin, not a behavior change.

**Lane header = nameboard**: lane-color fill, on-lane ink, 2px ink border,
display-800 uppercase lane name + tabular count right-aligned. Sticky-on-
scroll behavior is preserved. Lane numbers ("01"…"06") live in the roundel.

**Lane body = platform**: open white — 1.5px ink border, no top border, no
fill, no grey. Empty lane: centered mono uppercase letterspaced "Lane clear"
in `--ink-faint` (an empty lane is operational information).

**Mobile lane switcher** (≤900px): 3-column grid of stamped mini-plates, one
per lane — each keyed by a small lane-color square + label + count; active =
solid ink fill, `aria-pressed`. Replaces the Ledger toggle chips visually;
behavior unchanged.

**Queue discoverability hint** — see §6.

**Completed 24 h tab**: same tickets on a white panel (`--panel`, 2px ink
border); empty state "No jobs completed in the last 24 h." as a
`platform-empty`-style mono line.

### 4.4 Job ticket (board lanes, Completed 24 h, issue rows)

Anatomy (top to bottom):

1. **Lane bar**: `inset 6px 0 0 var(--lane)` — the line this job is on. In
   dark mode the Merged bar gains the halo (`inset 8px 0 0 var(--merged-halo)`).
2. **Repo line**: mono 0.58rem uppercase `--ink-faint`, ellipsis,
   `title` tooltip.
3. **Title link**: display 0.9rem/500 ink; `#nn` prefix in mono dim. Hover:
   2px underline, offset 3px, `--signal` underline color.
4. **Status row**: status tag (§5.1) + pause/start icon button (§5.4).
5. **Runtime lines**: mono 0.6rem `--ink-faint` — backend label, session id
   as an underlined dim button (opens Session usage dialog), copy control,
   worktree line.
6. **Via lines**: mono uppercase faint, 2px `--line-soft` left border,
   padding-left ("Via Build — 14 min").
7. **Journey legs** (§5.2): with the Kanban-only earlier-lane collapse —
   collapsed summary rows are **consistently lane-colored** (per #695): in
   the Review lane the Build summary is a Build-blue chip with white text
   ("▸ BUILD · 14M"); likewise everywhere, name + summed duration only.
   Expansion replaces the summary with that lane's chips; ephemeral local
   state (behavior per `docs/kanban.md`, unchanged).
8. **Merged-lane variant**: no legs; mono meta line ("Started 3 h ago ·
   Elapsed 23 m") + PR badge (§5.5).

Card frame: 1.5px ink border, white/`--panel` fill, no radius, no shadow.

### 4.5 Completed page (archive) — per #698 prototype

- **Page header**: signal-yellow kicker tag ("History"), display page title,
  lede in `--ink-dim`; mono note right-aligned (hidden ≤900px).
- **Archive slab**: the end of the line — route-line fragment with the 06
  roundel riding it, then a **Merged-black nameboard** ("Full archive" +
  mono sub + tabular count, 2px ink border, halo in dark mode). The motif
  extends to this single-column surface; no lane columns here.
- **Archive body**: `--panel`, 1.5px ink border (no top), 0.8rem padding,
  0.6rem row gap.
- **Rows**: hard-bordered cards.
  - *Complete* — 6px Merged line bar (`inset`, halo in dark). **No COMPLETE
    stamp** — Complete is the page's default; only exceptions are stamped.
  - *Abandoned* — dashed `--ink-faint` border, ghosted title (`--ink-dim`),
    dashed ABANDONED stamp.
- **Row anatomy**: repo line → title (1.06rem/600) with optional stamp →
  mono meta (backend — session ⧉ — worktree · merged/withdrawn timing ·
  elapsed; optional summary sentence in quotes, `--ink-dim`, sentence case)
  → footer: journey legs + PR badge or dashed "No change" tag.
- **Archive legs**: done steps carry **their lane color** (BUILD blue,
  REVIEW violet, CHECKS + MERGE PR green — CHECKS and MERGE are separate
  PR-green chips); unreached steps are dashed `--line-soft` with `--ink-faint`
  text ("○ REVIEW"). Retryable failures never appear here — they stay on the
  board; the archive is terminal Complete/Abandoned only.
  - **Failed-then-abandoned** (decided here, left open by #698): a step that
    failed before the withdrawal renders as an Attention-orange ✕ leg
    (`leg--fail`, §5.2) in its chronological position, followed by dashed
    unreached steps. The ABANDONED stamp stays the only stamp.
- **Refresh-failed banner** inside the slab (§4.8), Retry as mini plate.
- **Pagination**: hairline-top footer; mono status line left
  ("Page 2 of 9 · 21–40 of 178", `aria-live`); Prev/Next mini plates right.
- **Empty archive**: centered mono uppercase faint line in the slab body
  ("No completed work items yet").

### 4.6 Repos page

Repo cards and issue rows adopt the ticket language — the page has no
prototype, so this spec governs:

- **Repo card**: 1.5px ink-bordered white card. Header: display-600
  projectPath link (hover signal-underline) + mono open-PR count; controls:
  collapse chevron, pause/start icon button, kebab menu (§5.6).
- **Meta table**: hairline top/bottom borders, two columns — mono uppercase
  dt labels, mono values with inherit annotations ("Harness default (x)").
- **Credential banners**: standard banner pattern (§4.8), attention tag —
  "GitHub token required" / "GitLab authentication required" — with the CTA
  as a primary plate ("Create GitHub token", "Store in Keymaxxer"); guidance
  copy keeps `<code>` chips (mono, 1.5px ink border, paper fill).
- **Relevant issues section**: mono kicker + refresh icon button; issue rows
  use ticket anatomy (mono `#nn`, display title link, author sub-line).
  Stamps: **Closed** = dashed neutral stamp; **Blocked** = solid Queue-yellow
  tag (a blocked issue is queue-held — lane-consistent). Blocked rows keep
  the "Blocked by #n" mono link line; the old amber row-wash is dropped —
  the yellow tag carries the state, no wash fills in the new language.
- **Latest work item** renders the standard lifecycle chrome (§4.4 status
  block) inside a bordered inset panel (`--panel`, 1.5px).
- **Parent issue groups**: `<details>` card, 1.5px border — summary with
  parent link, "n/m closed" mono, chevron, parent actions menu; children
  with a 2px `--line-soft` left rule.
- Page footer: the shared add-repo guidance (§4.7).

### 4.7 Blank slate (home + repos, zero repositories)

- Centered panel: 2px **dashed** ink border (the one place dashed leads —
  the surface doesn't exist yet), white fill, generous padding.
- Signal kicker tag ("Setup"), display heading "No repositories configured".
- Add-repo form: mono path input (1.5px ink border, focus = global ink
  outline), "Browse…" mini plate (when available), primary submit plate
  (solid ink, label cycles Inspect → Inspecting… → Confirm and add →
  Adding…).
- "Confirm forge identity" fieldset: 1.5px ink border, mono uppercase legend.
- Divider: hairline + mono "or"; operator-binary hint with a mono `<code>`
  command chip.
- Inline `role="alert"` errors: attention-tagged banner style, compact.

### 4.8 Banners (all surfaces)

One pattern, two tones:

- **Frame**: 2px ink border, paper/panel fill, flex row, 0.5–0.7rem padding.
- **Tag**: mono 0.62rem/700 uppercase, 0.18rem/0.45rem padding —
  - **Alarm** (backend unavailable, refresh failed, credential missing,
    live-updates transport down): `--lane-attention` fill, `#151515` text.
  - **Guidance** (first-run, unconfigured setup): `--signal` fill, `#151515`
    text.
- **Body**: display 0.92rem/500 ink.
- **Action**: mini plate, right-aligned ("Open Settings", "Retry").
- Placement: nav-level banners sit between ribbon and page content; panel-
  level banners inside their panel. Existing show/hide logic (mutual
  exclusion, dialog suppression) is behavior and stays.

### 4.9 Dialogs (settings, repository settings, session usage)

Shared shell (native `<dialog>`):

- **Panel**: `--paper` fill, 2px ink border, no radius, `w-[min(92vw,32rem)]`
  (28rem for session usage), centered; backdrop `rgb(21 21 21 / 0.45)` both
  themes.
- **Header**: mono kicker (signal tag or plain mono eyebrow), display title,
  lede in `--ink-dim`. Guidance/alarm callouts = compact banners (§4.8).
- **Fields**: label grid; inputs/selects 1.5px ink border, paper fill, mono
  or display per content; focus = global `:focus-visible`; disabled dims to
  `--ink-faint`; helper lines mono `--ink-faint`. Checkboxes keep native
  control, accent-color `--signal`.
- **Status rows** (backend health): `--panel` inset boxes, mono status text.
- **Footer**: hairline top border, `--panel` fill, right-aligned — Cancel
  (stamped mini plate) + Save (solid ink plate, white uppercase mono label,
  "Saving…" pending).
- **Session usage table**: borderless; row labels display, values mono
  tabular; telemetry-state boxes (UNSUPPORTED/MISSING/UNAVAILABLE) as compact
  guidance banners.

### 4.10 Menus

- **Trigger**: square stamped mini plate with ⋮/kebab glyph,
  `aria-haspopup="menu"` + `aria-expanded`.
- **Panel**: absolute, right-aligned, `--panel` fill, 2px ink border, **no
  drop shadow** (flush aesthetic), `py-1`.
- **Items**: full-width, left-aligned, mono 0.68rem uppercase; hover =
  `--plate-hover`. Destructive items ("Remove"): hover = `--lane-attention`
  fill with `#151515` text (no orange text on white). `hr` = `--line-ghost`.
- Dismissal (outside pointerdown, Escape) unchanged; the parent-issue error
  popover becomes a compact alarm banner panel.

### 4.11 Loading, skeletons, spinners, tooltips, copy

- Skeletons: pulse bars/rows in `--line-ghost` over `--panel`,
  `motion-reduce`-safe.
- Icon spinners: inline SVG `animate-spin` in currentColor.
- Tooltips: native `title` — no custom tooltip component in this system.
- **Copy control**: mono truncated value + icon button; hover `--panel`;
  success = check glyph in `--lane-pr` for 1.5s (replaces the Ledger olive).

## 5. Components

### 5.1 Status tags (badges)

Uppercase mono 0.56–0.62rem/700, 1.5px ink border, 0.18rem/0.4rem padding.
Ledger tones map to lane logic:

| Status | Treatment |
| --- | --- |
| FAILED / INTERRUPTED | **Alarm**: `--lane-attention` fill, `#151515` text |
| NEEDS_HUMAN / NEEDS_HUMAN_REVIEW | **Alarm** (same fill — distinction lives in the label) |
| WAITING_FOR_BLOCKERS / WAITING_FOR_WORKER_SLOT | **Hold**: dashed 1.5px ink border, `--ink-dim` text |
| COMPLETE / SUCCEEDED | Solid `--ink` fill, `--paper` text (only where shown — the archive stamps nothing complete) |
| ABANDONED / CANCELLED | **Ghost**: dashed `--ink-faint` border, `--ink-dim` text |
| Default (QUEUED / RUNNING / in progress) | Plain: 1.5px ink border, `--ink-dim` text |

Status message line under the tag: mono, `--ink-dim`; for alarm statuses
prefix "▲" in `--lane-attention` with ink message text (attention orange is a
fill color, never small text on white — body-text contrast stays ≥ 4.5:1).

### 5.2 Journey-leg chips

Mono 0.56–0.62rem, 1.5px ink border, 0.16–0.2rem/0.38–0.44rem padding,
whitespace-nowrap. Five states:

| State | Treatment | Example |
| --- | --- | --- |
| Done (board) | solid `--ink` fill, `--paper` text | `✓ DEPS · 41S` |
| Done (archive) | lane-color fill, on-lane text (`leg--lane`) | `✓ BUILD · 14M` |
| Running | current-lane fill, on-lane text | `▷ IMPLEMENT · 12M` |
| Next / queued / unreached | dashed border, `--ink-faint` text | `○ MERGE` |
| Failed | `--lane-attention` fill, `#151515` text, 700 | `✕ REVIEW · 3M` |

The DECIDE_PR_MERGE needs-human chip keeps its external-link behavior (hover
underline).

### 5.3 Stamped plates (buttons)

- **Nav plate**: 2px `#000` border, `--mast-plate` fill, rivet dots
  (radial-gradient 1.6px at top corners), bevel
  (`inset 0 1px 0 hi, inset 0 -2px 0 rgb(0 0 0 / 0.3)`), mono 0.7rem/700
  uppercase; hover `--mast-plate-hover`; active = light plate.
- **Mini plate** (pagination, banner actions, Browse, Cancel): 2px ink
  border, `--plate` fill, same rivet/bevel pattern (1.4px dots), mono
  0.68rem/700 uppercase; hover `--plate-hover`.
- **Primary plate** (Save, Inspect/Confirm, credential CTAs): solid `--ink`
  fill, `--paper` uppercase mono label, 2px ink border; hover inverts to
  `--signal` fill / `#151515` text. Pending state = label swap ("Saving…"),
  no spinner.

### 5.4 Icon buttons (pause/start, reset, refresh, collapse, copy)

- Ghost square, 1px `--line-ghost` border, mono glyph or inline SVG; hover =
  ink border + ink glyph.
- Destructive/armed states (reset trash, pause-when-error): 1.5px
  `--lane-attention` border + glyph; hover = attention fill, `#151515` glyph.
- Pending = inline SVG spinner. `title` tooltips carry the verb.

### 5.5 PR badge

Mono 0.62–0.68rem/700, `--prbadge-bg` fill, `--prbadge-ink` text,
`--prbadge-border` border (halo in dark), 0.2–0.24rem/0.5–0.55rem padding,
"PR #n ↗". Hover: `--lane-pr` fill. When the PR URL exists, the status tag
links to the PR (existing behavior).

### 5.6 Stamps

Small mono uppercase chips for exception states (Closed, Blocked, Abandoned,
"No change"): 1.5px border, 0.2rem/0.45rem padding. Neutral = dashed
`--ink-faint`; Queue-yellow = solid `--lane-queue` with `#151515` text.
Stamps mark exceptions only — defaults go unstamped.

## 6. Queue discoverability hint ("Feed the queue")

A permanent fixture at the **foot of the Queue platform**, always rendered
(not only when the lane is empty), linking to `/repos`:

- **Panel**: `--lane-queue` fill, 2px ink border, 0.6–0.7rem padding.
- **Tag**: solid ink fill, Queue-yellow mono uppercase text ("Queue").
- **Copy** (plain words, per #695): "Feed the queue — work starts at your
  repos."
- **Link**: mono 0.62rem/700 uppercase, ink, 1.5px underline offset 3px —
  "Manage repos →"; hover = ink fill, Queue-yellow text, no underline.
- No transit glyphs (no ⇄), no "Transfer" wording anywhere.

## 7. Accessibility

- Color never carries meaning alone: every lane-colored element also has a
  text label (lane name, chip label, tag text).
- On-lane text colors are fixed pairs (§2.1) — do not derive them.
- Body text contrast ≥ 4.5:1 in both themes; mono micro-labels ≥ 3:1
  (large/short-label exception), which the token pairs satisfy.
- All interactive elements keep the global 2px focus outline; on the
  masthead it flips to `--signal`.
- Existing ARIA semantics (tabs, lane switcher `aria-pressed`, `aria-live`
  pager, dialog behavior, `sr-only` count labels) are behavior — unchanged.

## 8. Voice — the de-training rule

The metaphor stays visual; the words are plain. Banned vocabulary (from
#695): "Transfer / change here", "system map", "Network key", "Departed",
"Six-stop work network — all lines running", "Service board". Plain
replacements: "Feed the queue — work starts at your repos", "Merged PR
throughput", "All lanes live" (masthead status), "Full archive". Roundels,
route lines, and lane numbers (01–06) stay as pure graphics with
`aria-hidden` where decorative.

## 9. Migration notes (Ledger → Interchange)

**Yes: the design system is its own token/CSS layer** (resolving the map's
open fog). Concretely:

1. **Token layer first.** Add the §2 token set as one CSS module
   (lane/fonts un-themed + `:root`/light + `[data-theme="dark"]` overrides)
   alongside the Ledger `@theme`. Components then consume tokens only — no
   raw hex outside the layer. Tailwind `@theme` aliases may map tokens to
   utilities, but the custom-property layer is canonical.
2. **Fonts.** Load Inter Tight (400–800) + JetBrains Mono (400, 700); the
   serif stack and its `font-serif` utility are deleted once no surface
   references them. (Self-host vs. CDN is an implementation choice.)
3. **Theme plumbing.** Add `data-theme` on `<html>` +
   `prefers-color-scheme` default + the masthead toggle plate. Both themes
   ship from the **first migrated surface** — no retrofit (per #695).
4. **Suggested surface order** (each independently shippable):
   nav shell + banners → board (stats, controls, network, tickets, queue
   hint) → completed page → repos page → dialogs/menus/chrome. The board is
   where the motif lives, so migrating it early forces the token layer to
   settle; dialogs last because they're self-contained.
5. **What dies at the end**: Ledger `@theme` palette (paper/sepia/oxblood/
   olive/teal washes), the serif stack, textured paper background, offset
   block shadows, grey concrete lane fills, `.stamp`/`.field-rule`/
   `.entry-rule` Ledger component classes, and the old `statusBadge` tone
   table (replaced by §5.1). `docs/kanban.md`'s "adapted to the active
   design system" note now points here.
6. **Behavior is out of scope for migration**: lane classification, chip
   collapse logic, tab keyboard behavior, filtering, dialogs' show/hide —
   all untouched.

## 10. Out of scope (restating the map)

- Implementing this system (separate effort, its own tickets/map).
- Changing Kanban board structure or behavior; new features beyond the Queue
  hint.
- A component-library refactor (the spec describes treatments, not module
  boundaries).
