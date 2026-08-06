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
new features beyond the Queue discoverability hint. This document is the
visual contract; **implementation is Tailwind-first** (`ARCHITECTURE.md`,
§9) — shared recipes in `apps/harness/src/ui.ts`, tokens in
`apps/harness/src/styles.css`.

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
| `--dialog-stage` | `#f3f5f3` | muted stage behind sectioned settings dialogs |
| `--ink` | `#151515` | text, borders, route line |
| `--ink-dim` | `#4a4a4a` | secondary text, chip text |
| `--ink-faint` | `#8b8b8b` | meta text, empty states |
| `--line-soft` | `rgb(21 21 21 / 0.30)` | secondary borders |
| `--line-ghost` | `rgb(21 21 21 / 0.12)` | hairlines, ghost borders |
| `--signal` | `#ffd21c` | accent: selection, hover, kicker tags (= Queue yellow) |
| `--merged-halo` | `transparent` | halo behind Merged black (not needed on white) |
| `--warn-ink` | `#7c3a00` | non-fatal warning text (Agent Backend status/preview) |

Dark (`[data-theme="dark"]`):

| Token | Value |
| --- | --- |
| `--paper` | `#3a3f44` |
| `--panel` | `#2a2f34` |
| `--dialog-stage` | `#23272b` |
| `--ink` | `#f2f3f1` |
| `--ink-dim` | `#c6cac8` |
| `--ink-faint` | `#7f8583` |
| `--line-soft` | `rgb(242 243 241 / 0.32)` |
| `--line-ghost` | `rgb(242 243 241 / 0.14)` |
| `--signal` | `#ffd21c` (unchanged) |
| `--merged-halo` | `rgb(242 243 241 / 0.85)` |
| `--warn-ink` | `#fcd34d` |

**The Merged halo rule.** Merged black `#151515` vanishes on dark paper, so
every Merged-black element — roundel, nameboard edge, ticket line bar, stamp,
PR badge — gains a white hairline halo in dark mode (`--merged-halo`). In
light mode the halo token is transparent. This is the one per-theme
compensation; everything else is a straight token swap.

**Lane bed is theme-invariant.** `--lane-bed: #dedbd2` (warm grey column fill
under the colored nameboards) is the same in light and dark — the Kanban
keeps the light-mode platform grey rather than going lights-out.

**The warning-ink rule.** Non-fatal warning text uses `--warn-ink` — burnt
end of the warning ramp on light, pale end on dark — and both ends clear
4.5:1 on every surface a warning lands on (paper, panel, dialog stage,
plate). Warning color comes from the theme token, **never** from a Tailwind
`dark:` variant: `dark:` compiles to `prefers-color-scheme`, so a light
Harness surface under a dark OS preference would paint the pale ink on pale
plate (#830). Like the plate group, `--warn-ink` is re-locked to its light
value inside `[data-theme="dark"] [data-kanban-surface]`.

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

The band carries a low-contrast, full-width forged-iron scrollwork rail behind
the brand and controls. A matte grain, dark vignette, and bevel-highlighted
iron strokes add depth without reducing foreground contrast.

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
| Card title (relaxed) | 1.06rem / 600, ls −0.01em | archive rows, repos cards |
| Issue title (repos list) | 0.95rem / 500 | relevant-issue rows |
| Issue number (relaxed) | 0.72rem mono / 600 | archive + repos issue # |
| Body / lede | 0.92–0.98rem / 400–500 | banners, descriptions, archive summary |
| Meta (relaxed) | 0.78rem mono, normal-case | archive session/timing line |
| Meta labels (repos) | 0.75rem mono / 700 uppercase | repo meta dt |
| Meta values (repos) | 0.9rem mono / 400 | repo meta dd |
| Kicker (relaxed) | 0.62rem mono / 700, ls 0.22em | archive repo path, “Relevant issues” |
| Meta (board) | 0.58–0.62rem mono uppercase | repo lines, runtime, via |
| Chips / legs (relaxed) | 0.85rem mono / 700 | archive BUILD/REVIEW/PR legs |
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
- **Shadows: inset only.** Plate bevels are inset-only: mini/primary plates
  use **top highlight only** (`inset 0 1px 0 var(--plate-hi)`) so wide
  buttons do not grow a dark bottom bar; mast plates may still use a bottom
  strip. Ticket lane bar (`inset 6px 0 0 var(--lane)`), active-filter
  underline (`inset 0 -3px 0 var(--ink)`). **No offset block shadows and no
  drop shadows anywhere** — the Ledger `5px 5px 0` / `2px 2px 0` blocks and
  the menu drop shadow are gone; elevation reads through the hard border.

### 2.8 Spacing

Named slots (rem), transcribed from the prototypes:

| Slot | Value | Where |
| --- | --- | --- |
| page padding | 1.6–1.8 / 2.2 (y/x); 1.2–1.3 / 1.4 ≤900px | page shell (`ui.pageShell`) |
| masthead padding | 1.5 / 2.2; 1.2 / 1.4 ≤900px | masthead (`ui.mast`) |
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
- Merged-PR stats use paper fill in both themes (§4.2) — no pitch-black
  departure slab in dark.

## 4. Surfaces

### 4.1 Nav shell (every route)

**Masthead** — full-width dark supergraphic band (`--mast-bg`), flex with
brand left and nav right, items baseline-aligned.

- **Forged field**: ornamental wrought-iron rails span the full width behind
  both brand and controls. Black shadow, charcoal body, and a faint upper-edge
  highlight create forged depth; the ornament is decorative and `aria-hidden`.
- **Brand block**: mono kicker with version only (`--mast-dim`; product name
  and "Operator board" are not repeated here), wordmark link in display 800
  uppercase white (hover: `--signal`), mono sub-line with live status fragment
  in `--signal`.
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

- **Both themes**: `--paper` fill, 2px ink border, no title/tag header —
  five cells only, divided by `--line-ghost` hairlines; mono period labels
  (`--ink-dim`) above ink tabular numerals. Dark mode uses the same soft
  charcoal paper as the page (not a black departure-board slab).
- Loading = five skeleton bars in line-ghost tones; load failure = inline
  banner (§4.8) inside the panel.

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
fill, 2px ink border, mono work-item count) riding the line. Merged's black disc
gets a white border + ink outline so it reads on the black line.

≤1500px the route line is hidden and the roundel shrinks to a 1.4rem badge
pinned on the nameboard. ≤900px the existing single-lane mobile behavior
stays (lane switcher below) — this is a re-skin, not a behavior change.

**Lane header = nameboard**: a brushed lane-color alloy sheet in a dark metal
frame, fixed by four dome rivets. Specular, grain, bevel, and inset-shadow
layers give the sheet depth without an image asset. The uppercase lane name
uses the fixed on-lane ink; a small decorative `RFA / 01`…`06` serial is
`aria-hidden`. Sticky-on-scroll behavior is preserved. Operational counts stay
in the route roundels and mobile lane switcher.

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
   **Needs Human exception (Kanban only, #764):** when the Work Item is
   terminal Needs Human **and** a PR number/URL exists, the top status tag is
   **omitted** and the PR badge (§5.5) moves into this row instead (primary
   open-PR action). The outcome chrome below keeps a single Needs Human
   status badge and does **not** also render a PR badge. Needs Human without
   a PR keeps the top status tag (no empty PR slot). Non–Needs Human tickets
   and repository issue rows keep the normal top status tag + outcome PR
   layout. Pause stays in the status row in all cases.
5. **Runtime lines**: mono 0.8rem `--ink-faint` — each on its own line:
   backend label; session id (underlined button + copy); worktree when set.
   (Title stays at relaxed card size; only meta under the title is larger.)
6. **Via lines**: mono uppercase faint, 2px `--line-soft` left border,
   padding-left ("Via Build — 14 min").
7. **Journey legs** (§5.2): earlier-lane collapse is shared by **Kanban
   tickets and repos lifecycle chrome** — collapsed summary chips are
   **consistently lane-colored** (per #695) and sit on **one horizontal wrap
   row** (per #784), not stacked as separate lines: in the Review lane the
   Build summary is a Build-blue chip with white text ("▸ BUILD · 14m");
   likewise everywhere, name + summed duration only. Multiple collapsed
   legs (e.g. BUILD + REVIEW on a PR-focus ticket, or BUILD + REVIEW +
   PR|MR on terminal COMPLETE) share that single wrap line. Expanding a
   leg keeps the summary row intact and reveals that lane's fine-grained
   chips as a full-width strip beneath; ephemeral local state (behavior per
   `docs/kanban.md`, unchanged).
8. **Merged-lane variant**: no per-step legs on the board; mono lines for
   **Started** and **Elapsed** separately; PR badge (§5.5). Fill is the same
   parchment as every other lane (see card frame below).

Card frame: 1.5px ink border, warm parchment `--ticket-fill` (`#f4f1e8` /
rgb(244, 241, 232) light; soft charcoal lift dark) in every board lane —
not pure white, not brushed metal. No radius, no offset shadow.

### 4.5 Completed page (archive) — per #698 prototype

- **Page header**: signal-yellow kicker tag ("History"), display page title,
  lede in `--ink-dim`; mono note right-aligned (hidden ≤900px).
- **Archive slab**: the end of the line — route-line fragment with the 06
  roundel riding it, then a **Merged-black nameboard** ("Full archive" +
  mono sub + tabular count, 2px ink border, halo in dark mode). The motif
  extends to this single-column surface; no lane columns here.
- **Archive body**: `--panel`, 1.5px ink border (no top), 0.8rem padding,
  0.6rem row gap.
- **Rows**: hard-bordered cards sharing the **repos** type + shell language
  (1.1rem padding, brushed-metal light fill / `--panel` dark).
  - *Complete* — 6px Merged line bar (`inset`, halo in dark). **No COMPLETE
    stamp** — Complete is the page's default; only exceptions are stamped.
  - *Abandoned* — dashed `--ink-faint` border, ghosted title (`--ink-dim`),
    dashed ABANDONED stamp.
- **Row anatomy** (repos-aligned type):
  - repo path = mono kicker (0.62rem / 700, tracking 0.22em uppercase, faint)
  - title = display 1.06rem / 600, ls −0.01em; `#n` = mono 0.72rem / 600
    (same as relevant-issue numbers); signal underline on hover
  - meta = mono 0.78rem normal-case (backend — **full session id** ⧉ —
    worktree · merged/withdrawn timing · elapsed; wraps, never truncates id)
  - optional summary quote = display 0.92rem / 500, sentence case
  - footer journey legs; forge badge (`PR #n` / `MR #n`) **top-right** with
    Abandoned stamp when both apply; dashed "No change" in the footer
- **Card grid**: `auto-fill` with a **34rem** minimum column (~3 cards on a
  wide row, not 4).
- **Archive legs**: done steps carry **their lane color** (BUILD blue,
  REVIEW violet, **one** PR-green chip labelled **PR** on GitHub or **MR** on
  GitLab — create/checks/merge are summed into that single leg so the footer
  is not two lookalike green controls next to the black open-on-forge badge).
  Legs with underlying step history are **expandable** (▸ / ▾, same pattern as
  Kanban earlier-lane summaries): expand replaces the condensed duration with
  the fine-grained lifecycle chips for that lane; expand state is ephemeral
  per card. Unreached steps are dashed `--line-soft` with `--ink-faint` text
  ("○ REVIEW") and are not expandable. Retryable failures never appear here —
  they stay on the board; the archive is terminal Complete/Abandoned only.
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

- **Repo card**: 1.5px ink-bordered card. Light mode: slight brushed-metal
  fill (soft plate gradient, not flat white on paper). Dark mode: `--panel`.
  Header: display-600 projectPath link (hover signal-underline) + mono
  open-PR count; controls: collapse chevron, pause/start icon button, kebab
  menu (§5.6).
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
- **Latest work item** renders the standard lifecycle chrome (§4.4) inside a
  bordered inset panel (`--panel`, 1.5px): runtime lines (agent backend,
  session + copy, worktree + copy), STARTED / status, and earlier-lane
  collapse for step chips (same as Kanban). For **terminal COMPLETE**, every
  reached lifecycle lane (BUILD, REVIEW, and **PR** on GitHub / **MR** on
  GitLab) collapses by default into expandable journey-style legs — PR is not
  left as a permanent full chip strip just because focus falls back to the
  last phase. Collapsed legs share **one horizontal wrap row** (same density
  language as archive footer legs §4.5; not one vertical line per leg).
  Expanding a leg leaves the summary row in place and shows that lane’s
  fine-grained chips in a strip under the row. Duration on each leg is the
  sum of that lane’s chip `durationMs` (same rules as earlier-lane summaries
  / archive legs §4.5). Non-complete work still expands only the current
  focus lane; when multiple earlier-lane summaries are present they use the
  same single-line wrap treatment.
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
  (riveted plate twin of mini — same recipe as dialog Save; label cycles
  Inspect → Inspecting… → Confirm and add → Adding…).
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
- **Sectioned settings body** (harness + repo settings — prototype D stamped
  plates): muted stage behind cards (`--dialog-stage`: `#f3f5f3` light /
  `#23272b` dark).
  **Section cards** use 1.5px ink border, `--paper` fill, heavy 2px ink head
  rule with display title (0.78rem/800 uppercase) + optional mono meta
  (0.58rem faint). Groups: Agent backend / Models / Concurrency (harness);
  Forge identity / Options / Agent backend / Models (repo). Full-width stacked
  field rows — do not side-by-side effort fields.
- **Fields**: label on paper — display 0.8rem/600 `--ink-dim` (not the same
  weight/color as the control value). **Controls** (selects / number inputs)
  are physical plate objects: `--plate` fill, 1.5px ink border, bold
  `--plate-ink` value text (~0.95rem), inset top highlight (and light bottom
  plate-lo line); mono for model IDs. Focus = global `:focus-visible`;
  disabled dims opacity. **Hints** readable body size (~0.82rem display,
  `--ink-dim`) — not mono microcopy. Checkboxes keep native control,
  accent-color `--signal`.
- **Status rows** (backend health): plate-fill inset boxes (ink border, top
  highlight), mono status text; Recheck actions use mini plates.
  **Non-fatal warning lines** inside a status row or status label: readable
  body copy (display ~0.82rem/600, not inherited mono microcopy) in
  `--warn-ink` with a 2px left rule in the same ink, so the warning state is
  structural as well as colored (§7). One shared recipe
  (`ui.dialogStatusWarning`, rendered by `AgentBackendWarnings`) covers every
  site; `role="status"` and the non-fatal semantics are behavior.
- **Footer**: hairline top border, `--panel` fill, right-aligned — **all
  buttons** are riveted stamped plates (Cancel + Save share the same plate
  recipe as Recheck / mini plates; no solid-ink primary). Save pending =
  label swap ("Saving…"), no spinner. Top inset highlight only on plates —
  no bottom `-2px` strip (reads as an extra bar under wider buttons in dark
  mode).
- **Session usage table**: plain body (not sectioned stage); borderless
  table; row labels display, values mono tabular; telemetry-state boxes
  (UNSUPPORTED/MISSING/UNAVAILABLE) as compact guidance banners.

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

Mono 0.56rem (board) / 0.85rem (archive), 1.5px ink border; board padding
0.16–0.2rem/0.38–0.44rem, archive legs 0.4rem/0.7rem. Whitespace-nowrap.

**Collapsed multi-leg layout (Kanban tickets, repos lifecycle chrome, archive
footer):** summary legs share one `flex flex-wrap` row (`ui.legRow` /
`ui.archiveFoot`). They wrap only when card/column width requires it — never
stacked as one vertical line per leg by default (#784). Expanded detail is a
full-width chip strip under that row (summary buttons stay on the row with
▸/▾). Keep `aria-expanded` / `aria-controls` on each expandable leg button.

Five states:

| State | Treatment | Example |
| --- | --- | --- |
| Done (board) | solid `--ink` fill, `--paper` text | `✓ DEPS · 41S` |
| Done (archive) | exact lane fill (`--leg-lane`), on-lane text (`--leg-on`) | `BUILD · 14m` |
| Running | current-lane fill, on-lane text | `▷ IMPLEMENT · 12M` |
| Next / queued / unreached | dashed border, `--ink-faint` text | `○ PR` / `○ MR` |
| Failed | `--lane-attention` fill, `#151515` text, 700 | `✕ REVIEW · 3M` |

The DECIDE_PR_MERGE needs-human chip keeps its external-link behavior (hover
underline).

### 5.3 Stamped plates (buttons)

- **Nav plate**: 2px `#000` border, `--mast-plate` fill, rivet dots
  (radial-gradient 1.6px at top corners), bevel
  (`inset 0 1px 0 hi, inset 0 -2px 0 rgb(0 0 0 / 0.3)`), mono 0.7rem/700
  uppercase; hover `--mast-plate-hover`; active = light plate.
- **Mini plate** (pagination, banner actions, Browse, Cancel, Recheck): 2px
  ink border, `--plate` fill, top-left + top-right rivets (1.4px dots),
  **top inset highlight only** (`inset 0 1px 0 var(--plate-hi)` — no bottom
  `-2px` strip), mono 0.68rem/700 uppercase; hover `--plate-hover`.
- **Primary plate** (Save, credential CTAs, other dialog actions): **riveted
  stamped-plate twin of mini** — same `--plate` fill, rivets, and top-only
  bevel (not solid-ink fill). Hierarchy is position/label only so Cancel and
  Save cannot drift. Pending state = label swap ("Saving…"), no spinner.

### 5.4 Icon buttons (pause/start, reset, refresh, collapse, copy)

- Square, 1px `--ink` border + `--ink` glyph (full contrast so kebabs stay
  legible on metallic repo cards / mid-tone panels); hover = plate wash.
- Destructive/armed states (reset trash, pause-when-error): 1.5px
  `--lane-attention` border + glyph; hover = attention fill, `#151515` glyph.
- Pending = inline SVG spinner. `title` tooltips carry the verb.

### 5.5 PR badge

Mono 0.62–0.68rem/700 (archive uses `archiveLeg` size), **outline**: 1.5px
ink border, transparent fill, ink text — quieter than a solid black stamp.
0.2–0.24rem/0.5–0.55rem padding, "PR #n ↗". Hover: `--lane-pr` fill + white
text. When the PR URL exists, the status tag links to the PR (existing
behavior). On Kanban tickets in terminal Needs Human with a PR, the badge
sits in the top status row instead of the outcome row so the card never
shows two PR controls or two title-adjacent Needs Human tags (§4.4).

### 5.6 Stamps

Small mono uppercase chips for exception states (Closed, Blocked, Abandoned,
"No change"): 1.5px border, 0.2rem/0.45rem padding. Neutral = dashed
`--ink-faint`; Queue-yellow = solid `--lane-queue` with `#151515` text.
Stamps mark exceptions only — defaults go unstamped.

## 6. Queue discoverability hint ("Feed the queue")

A permanent fixture at the **foot of the Queue platform**, always rendered
(not only when the lane is empty):

- **Panel**: `--lane-queue` fill, 2px ink border, 0.6–0.7rem padding.
- **Tag**: solid ink fill, Queue-yellow mono uppercase text ("Queue").
- **Copy** (plain words; workflow per #730): "Feed the queue — label issues
  with `ready-for-agent`. When they show up in your repos, click
  **Implement now**." Prefer neutral "issues" over a forge brand name.
- **Illustration**: compact static mock of the repos issue ⋮ menu showing
  **Implement now** and **Implement locally** (decorative, `aria-hidden`)
  so operators recognize the control on Repos.
- No primary "Manage repos" CTA — keep the hint focused on label → Implement
  now.
- No transit glyphs (no ⇄), no "Transfer" wording anywhere.

## 7. Accessibility

- Color never carries meaning alone: every lane-colored element also has a
  text label (lane name, chip label, tag text).
- On-lane text colors are fixed pairs (§2.1) — do not derive them.
- Body text contrast ≥ 4.5:1 in both themes; mono micro-labels ≥ 3:1
  (large/short-label exception), which the token pairs satisfy.
- Text color follows the Harness theme token, never a Tailwind `dark:`
  (`prefers-color-scheme`) variant — the OS preference and the visible surface
  can disagree, which breaks contrast (§2.2 warning-ink rule).
- All interactive elements keep the global 2px focus outline; on the
  masthead it flips to `--signal`.
- Existing ARIA semantics (tabs, lane switcher `aria-pressed`, `aria-live`
  pager, dialog behavior, `sr-only` count labels) are behavior — unchanged.

## 8. Voice — the de-training rule

The metaphor stays visual; the words are plain. Banned vocabulary (from
#695): "Transfer / change here", "system map", "Network key", "Departed",
"Six-stop work network — all lines running", "Service board". Plain
replacements: "Feed the queue — label issues with ready-for-agent…", "Merged PR
throughput", "Clanker Harness" (masthead status under “Ready for Agent”),
"Full archive". Roundels,
route lines, and lane numbers (01–06) stay as pure graphics with
`aria-hidden` where decorative.

## 9. Implementation policy (Tailwind + tokens)

**Styling is Tailwind-first** (also `ARCHITECTURE.md`). Treatments in this
document describe *look* — implement them with Tailwind utilities on
elements, not a parallel component stylesheet.

1. **Surfaces in utilities.** Put layout and chrome in `className` as
   Tailwind classes. Shared multi-class recipes live in
   `apps/harness/src/ui.ts` (static strings so Tailwind can scan them).
   Compose with `cx()` when needed.
2. **Token layer.** §2 lives as CSS custom properties (`:root` /
   `[data-theme="light|dark"]`) plus Tailwind `@theme` aliases so utilities
   work (`bg-paper`, `text-ink`, `bg-lane-build`, …). No raw hex in
   components except one-off illustrations.
3. **`styles.css` is residual only:** tokens, `@theme`, base (`body`,
   selection, focus-visible, reduced-motion), keyframes, and rare cases
   utilities cannot express cleanly (e.g. `dialog::backdrop`). Never grow
   named component rules for UI chrome.
4. **Fonts.** Inter Tight (400–800) + JetBrains Mono (400, 700) via
   `--font-display` / `--font-mono` and Tailwind `font-display` /
   `font-mono`.
5. **Theme plumbing.** `data-theme` on `<html>`, `prefers-color-scheme`
   default, masthead toggle, optional `?theme=light|dark` pin.
6. **Behavior** (lane classification, expand/collapse, filtering, dialogs)
   is out of scope for this visual contract.

## 10. Out of scope (restating the map)

- Changing Kanban board structure or behavior; new features beyond the Queue
  hint.
- A component-library refactor (the spec describes treatments, not module
  boundaries).
