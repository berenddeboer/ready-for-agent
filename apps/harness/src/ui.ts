/**
 * Tailwind-first shared class recipes for the harness UI.
 *
 * Prefer these (or inline utilities) over adding rules to `styles.css`.
 * Tokens, base, keyframes, and `dialog-backdrop` live in `styles.css`.
 * Compose with `cx(...)`. All strings are static so Tailwind can scan them.
 */

/** Filter falsy parts and join with a single space. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ")
}

/**
 * Rivet-plate background images (stamped industrial chrome).
 * Multi-layer radial gradients at the top corners.
 *
 * Right-edge positions must use `calc(100% - Npx)` (spaces around `-`).
 * Tailwind arbitrary values encode those spaces as `_`, so write
 * `calc(100%_-_Npx)`. Bare `calc(100%-Npx)` is invalid CSS and drops the
 * right-hand rivet entirely.
 */
const mastPlateRivets =
  "[background-image:radial-gradient(circle_1.6px_at_7px_7px,var(--mast-plate-rivet)_1.6px,transparent_2.1px),radial-gradient(circle_1.6px_at_calc(100%_-_7px)_7px,var(--mast-plate-rivet)_1.6px,transparent_2.1px)]"

const plateMiniRivets =
  "[background-image:radial-gradient(circle_1.4px_at_6px_6px,var(--plate-rivet)_1.4px,transparent_1.9px),radial-gradient(circle_1.4px_at_calc(100%_-_6px)_6px,var(--plate-rivet)_1.4px,transparent_1.9px)]"

/**
 * Active Jobs tab rivets: paper-colored dots contrast on `bg-ink` in both
 * themes. Full static string (variant + property) so Tailwind can scan it.
 */
const pipelineTabActiveRivets =
  "aria-[current=page]:[background-image:radial-gradient(circle_1.4px_at_6px_6px,var(--paper)_1.4px,transparent_1.9px),radial-gradient(circle_1.4px_at_calc(100%_-_6px)_6px,var(--paper)_1.4px,transparent_1.9px)]"

const laneSwitchRivets = plateMiniRivets

/**
 * Light-theme brushed metal for ticket-style cards (repo cards, completed
 * archive rows). Dark keeps solid `bg-panel`. Full static strings so Tailwind
 * can scan them.
 */
const cardMetalLight =
  "in-[html[data-theme=light]]:bg-[linear-gradient(165deg,rgb(255_255_255/0.72)_0%,rgb(255_255_255/0.18)_42%,transparent_68%),linear-gradient(180deg,#f0f2f0_0%,#e3e7e4_55%,#dfe4e1_100%)]"

export const ui = {
  /* ---------- Nav shell (§4.1) ---------- */

  // bg-mast-bg (not bg-[var(--mast-bg)]) so styles.css mast focus-ring selector matches.
  mast: "flex flex-wrap items-end justify-between gap-x-10 gap-y-[1.2rem] bg-mast-bg px-[2.2rem] pt-6 pb-[1.35rem] text-[var(--mast-ink)] max-[900px]:px-[1.4rem] max-[900px]:pt-[1.2rem] max-[900px]:pb-[1.1rem]",

  brandKicker:
    "m-0 mb-2 font-mono text-[0.62rem] tracking-[0.22em] uppercase text-[var(--mast-faint)]",

  /** Child `<b>` inside brand-kicker */
  brandKickerB: "font-normal text-[var(--mast-dim)]",

  brandWordmark:
    "m-0 font-display text-[clamp(2rem,4.2vw,3.1rem)] font-extrabold leading-[0.92] tracking-[-0.015em] uppercase",

  brandWordmarkLink: "text-[var(--mast-ink)] no-underline hover:text-signal",

  brandSub:
    "mt-[0.55rem] mb-0 font-mono text-[0.66rem] tracking-[0.16em] uppercase text-[var(--mast-dim)]",

  /** Child `.ok` inside brand-sub */
  brandSubOk: "text-signal",

  mastNav: "flex flex-wrap items-center gap-[0.55rem]",

  mastPlate: cx(
    "inline-flex items-center gap-2 border-2 border-black",
    "bg-[var(--mast-plate)] text-[var(--mast-plate-ink)]",
    mastPlateRivets,
    "shadow-[inset_0_1px_0_var(--mast-plate-hi),inset_0_-2px_0_rgb(0_0_0/0.3)]",
    "px-[0.95rem] py-[0.55rem]",
    "font-mono text-[0.7rem] font-bold tracking-[0.14em] uppercase no-underline",
    "cursor-pointer transition-[background-color,color] duration-100 ease-in-out",
    "hover:bg-[var(--mast-plate-hover)] hover:text-[var(--mast-ink)]",
    "aria-[current=page]:bg-[var(--mast-plate-active)] aria-[current=page]:text-[var(--mast-plate-active-ink)]",
    "aria-[current=page]:shadow-[inset_0_1px_0_rgb(255_255_255/0.65),inset_0_-2px_0_rgb(16_19_18/0.12)]",
    // Active rivets via arbitrary variant on same element (valid calc for right edge).
    "aria-[current=page]:[background-image:radial-gradient(circle_1.6px_at_7px_7px,var(--mast-plate-active-rivet)_1.6px,transparent_2.1px),radial-gradient(circle_1.6px_at_calc(100%_-_7px)_7px,var(--mast-plate-active-rivet)_1.6px,transparent_2.1px)]",
    "[&_svg]:h-[0.9rem] [&_svg]:w-[0.9rem] [&_svg]:shrink-0",
  ),

  /** Standalone if SVG is not nested under mastPlate */
  mastPlateSvg: "h-[0.9rem] w-[0.9rem] shrink-0",

  laneRibbon:
    "flex h-[0.4rem] [&>span]:flex-1 [&>span:nth-child(1)]:bg-lane-queue [&>span:nth-child(2)]:bg-lane-build [&>span:nth-child(3)]:bg-lane-review [&>span:nth-child(4)]:bg-lane-pr [&>span:nth-child(5)]:bg-lane-attention [&>span:nth-child(6)]:bg-lane-merged",

  laneRibbonSpan: "flex-1",
  laneRibbonSpan1: "bg-lane-queue",
  laneRibbonSpan2: "bg-lane-build",
  laneRibbonSpan3: "bg-lane-review",
  laneRibbonSpan4: "bg-lane-pr",
  laneRibbonSpan5: "bg-lane-attention",
  laneRibbonSpan6: "bg-lane-merged",

  appChrome: "sticky top-0 z-40 bg-paper",

  mergedPrStatsBand:
    "bg-paper px-[2.2rem] pt-[0.85rem] max-[900px]:px-[1.4rem] max-[900px]:pt-[0.7rem]",

  jobsSwitcherBand:
    "border-b border-line-ghost bg-paper px-[2.2rem] pt-3 pb-[0.85rem] max-[900px]:px-[1.4rem] max-[900px]:pt-[0.65rem] max-[900px]:pb-3",

  jobsSwitcherRow:
    "flex min-w-0 flex-nowrap items-center justify-between gap-x-5 gap-y-[0.85rem]",

  /**
   * When pipeline-tabs sits inside jobs-switcher-row.
   * Apply on the tabs element (or compose with pipelineTabs).
   */
  jobsSwitcherPipelineTabs: "shrink-0 grow-0 basis-auto",

  /**
   * When repository-filters sits inside jobs-switcher-row.
   */
  jobsSwitcherRepositoryFilters:
    "min-w-0 shrink grow basis-auto justify-end overflow-x-auto overscroll-x-contain [scrollbar-width:thin]",

  pageShell:
    "px-[2.2rem] pt-[1.1rem] pb-12 max-[900px]:px-[1.4rem] max-[900px]:pt-[0.95rem] max-[900px]:pb-[2.4rem]",

  /** Banner as direct child of page-shell */
  pageShellBanner: "mb-4",

  /* ---------- Banner pattern (§4.8) ---------- */

  banner:
    "flex flex-wrap items-center gap-x-[0.9rem] gap-y-[0.6rem] border-2 border-ink bg-panel px-[0.7rem] py-2 text-ink",

  bannerTag:
    "whitespace-nowrap px-[0.45rem] py-[0.18rem] font-mono text-[0.62rem] font-bold tracking-[0.16em] uppercase text-[#151515]",

  /**
   * Parent marker for alarm banners (no own box styles).
   * Compose bannerTag + bannerTagAlarm on the tag element.
   */
  bannerAlarm: "",

  bannerTagAlarm: "bg-lane-attention",

  /**
   * Parent marker for guidance banners.
   * Compose bannerTag + bannerTagGuidance on the tag element.
   */
  bannerGuidance: "",

  bannerTagGuidance: "bg-signal",

  bannerBody:
    "m-0 min-w-0 flex-[1_1_12rem] font-display text-[0.92rem] font-medium leading-[1.4] text-ink [&>p]:m-0",

  bannerBodyP: "m-0",

  bannerAction: "ml-auto",

  plateMini: cx(
    "inline-flex items-center gap-[0.4rem] border-2 border-ink",
    "bg-[var(--plate)] text-[var(--plate-ink)]",
    plateMiniRivets,
    "shadow-[inset_0_1px_0_var(--plate-hi),inset_0_-2px_0_var(--plate-lo)]",
    "px-[0.85rem] py-[0.46rem]",
    "font-mono text-[0.68rem] font-bold tracking-[0.12em] uppercase no-underline",
    "cursor-pointer transition-[background-color,color] duration-100 ease-in-out",
    "hover:bg-[var(--plate-hover)]",
    "disabled:cursor-not-allowed disabled:opacity-55",
    "disabled:aria-busy:cursor-wait",
  ),

  /**
   * Compact banner padding + body size. Targets font-display body child so
   * callers can pass this as Banner className without a separate body class.
   */
  bannerCompact: "px-[0.6rem] py-[0.45rem] [&_.font-display]:text-[0.88rem]",

  /** Body text size when inside compact banner (optional direct apply) */
  bannerBodyCompact: "text-[0.88rem]",

  /* ---------- Completed archive surface (§4.5) ---------- */

  pagehead:
    "mb-[1.7rem] flex flex-wrap items-end justify-between gap-x-8 gap-y-[0.8rem]",

  kickerTag:
    "inline-block bg-signal px-2 py-[0.18rem] font-mono text-[0.64rem] font-bold tracking-[0.2em] uppercase text-[#151515]",

  pageheadH1:
    "mt-[0.6rem] mb-0 font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-extrabold leading-[0.95] tracking-[-0.01em] uppercase text-ink",

  lede: "mt-[0.6rem] mb-0 max-w-[44rem] font-display text-[0.98rem] leading-[1.45] text-ink-2",

  pageheadNote:
    "m-0 whitespace-nowrap font-mono text-[0.68rem] tracking-[0.18em] uppercase text-ink-faint max-[900px]:hidden",

  archive: "mt-2",

  archiveLine:
    "relative h-[1.3rem] before:absolute before:top-[0.55rem] before:right-0 before:left-0 before:h-1 before:bg-ink before:content-['']",

  roundel:
    "absolute top-0 left-[2.2rem] grid h-[2.1rem] w-[2.1rem] place-items-center rounded-full border-2 border-white bg-lane-merged font-mono text-[0.68rem] font-bold text-white max-[900px]:left-4",

  nameboard:
    "flex items-baseline gap-[0.6rem] border-2 border-ink bg-lane-merged px-[0.8rem] pt-2 pb-[0.55rem] text-white shadow-[0_0_0_1px_var(--merged-halo)]",

  nameboardH2:
    "m-0 font-display text-[1.05rem] font-extrabold tracking-[0.07em] uppercase",

  nbSub:
    "font-mono text-[0.66rem] tracking-[0.16em] uppercase text-[rgb(255_255_255/0.65)]",

  nbCount:
    "ml-auto font-display text-[1.5rem] font-extrabold leading-none tabular-nums",

  archiveBody:
    "grid content-start gap-[0.6rem] border-[1.5px] border-t-0 border-ink bg-panel p-[0.8rem]",

  archiveBodyBanner: "m-0",

  archiveRows: "m-0 grid list-none gap-[0.6rem] p-0",

  /**
   * Completed archive card. Same shell, metal fill, and type scale as repo
   * cards (§4.6) so Completed and Repos read as one family.
   */
  archiveRow: cx(
    "grid min-w-0 gap-[0.55rem] border-[1.5px] border-ink bg-panel",
    "px-[1.1rem] pt-4 pb-[1.15rem]",
    cardMetalLight,
  ),

  archiveRowComplete:
    "shadow-[inset_6px_0_0_var(--lane-merged),inset_8px_0_0_var(--merged-halo)]",

  archiveRowAbandoned: "border-dashed border-ink-faint",

  archiveRowTop:
    "flex min-w-0 flex-nowrap items-center justify-between gap-x-4 gap-y-[0.6rem]",

  archiveRowTopEnd:
    "flex shrink-0 flex-nowrap items-center justify-end gap-[0.35rem]",

  /** Repo path kicker — same mono band as repos “Relevant issues”. */
  archiveRepo:
    "m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.62rem] font-bold tracking-[0.22em] uppercase text-ink-faint",

  /**
   * Issue title. Matches repo card title metrics (display 1.06 / 600).
   * Compose with archiveTitleLink on anchors.
   */
  archiveTitle:
    "m-0 block max-w-full font-display text-[1.06rem] font-semibold leading-[1.25] tracking-[-0.01em] text-ink no-underline [overflow-wrap:anywhere]",

  archiveTitleLink:
    "hover:text-ink hover:underline hover:decoration-signal hover:decoration-2 hover:underline-offset-[3px]",

  /** Issue number — same mono as repos issue rows. */
  archiveTitleNum:
    "mr-[0.45rem] font-mono text-[0.72rem] font-semibold leading-[1.45] tracking-normal text-ink-2",

  /** Title when row is abandoned */
  archiveTitleAbandoned: "text-ink-2",

  archiveStamp:
    "shrink-0 px-2 py-[0.22rem] font-mono text-[0.66rem] font-bold tracking-[0.14em] uppercase",

  archiveStampAbandoned:
    "border-[1.5px] border-dashed border-ink-faint bg-transparent text-ink-2",

  /**
   * Session / backend / timing line — repos meta value scale (mono, relaxed
   * tracking, no forced uppercase) rather than board density.
   */
  archiveMeta:
    "m-0 break-words whitespace-normal font-mono text-[0.78rem] font-normal tracking-[0.02em] normal-case text-ink-2 [overflow-wrap:anywhere]",

  archiveMetaSess:
    "cursor-pointer border-0 bg-transparent p-0 font-inherit tracking-[inherit] text-ink underline underline-offset-2 [overflow-wrap:anywhere] [word-break:break-all] hover:text-ink hover:decoration-signal",

  /** Completion quote — display body, not mono stamp. */
  archiveSummary:
    "m-0 font-display text-[0.92rem] font-medium leading-[1.4] normal-case text-ink-2",

  archiveJourney: "grid min-w-0 gap-[0.45rem]",

  archiveFoot: "flex flex-wrap items-center gap-[0.35rem]",

  /**
   * Journey-leg chips — board density floor (0.56rem) is the shared base.
   * Completed archive composes `archiveLeg` for a larger relaxed size.
   */
  // max-w-full + truncate: long lifecycle labels stay inside ticket columns.
  leg: "inline-flex max-w-full min-w-0 items-center overflow-hidden text-ellipsis whitespace-nowrap border-[1.5px] border-ink bg-transparent px-[0.38rem] py-[0.16rem] font-mono text-[0.56rem] tracking-[0.06em] text-ink-2 no-underline",

  /**
   * Completed-card journey legs — readable body-adjacent mono (board is
   * 0.56rem density; these need to scan as primary footer controls).
   */
  archiveLeg:
    "px-[0.7rem] py-[0.4rem] text-[0.85rem] font-bold tracking-[0.06em]",

  /**
   * Filled leg states use `!` so they beat base `leg` `bg-transparent` /
   * `text-ink-2` (otherwise expanded archive chips render white-on-metal).
   */
  legDone: "border-ink !bg-ink !text-paper",

  legRun:
    "border-ink !bg-[var(--leg-lane,var(--lane-build))] !text-[var(--leg-on,#fff)]",

  legNext: "border-dashed text-ink-faint",

  legFail: "border-lane-attention !bg-lane-attention font-bold !text-[#151515]",

  /**
   * Archive done legs (BUILD / REVIEW / PR|MR): exact lane fill + on-lane ink.
   * Pair with `archiveLegLaneStyle` for `--leg-lane` / `--leg-on`.
   * Compose with `archiveLeg` for size.
   */
  legLane:
    "border-ink !bg-[var(--leg-lane,var(--lane-build))] font-bold !text-[var(--leg-on,#fff)]",

  /** Archive skip (dashed ghost) — not redefined on board */
  legSkip: "border-dashed border-line-soft text-ink-faint",

  legExpandable:
    "inline-flex cursor-pointer items-center gap-[0.32rem] font-inherit tracking-inherit [text-transform:inherit] hover:brightness-105",

  archiveLegChips: "m-0 flex list-none flex-wrap gap-[0.4rem] p-0",

  /** Duration suffix inside expanded step chips — keep full contrast. */
  archiveLegChipDuration: "font-normal opacity-90",

  /**
   * Archive PR/MR badge — outline (ink border, transparent fill). Hover matches
   * board `prBadge`: PR-green fill + white text. Compose with `archiveLeg` for size.
   */
  prbadge: cx(
    "inline-flex items-center whitespace-nowrap border-[1.5px] border-ink",
    "bg-transparent font-mono text-ink no-underline",
    "hover:border-lane-pr hover:bg-lane-pr hover:text-white",
  ),

  prbadgeTop: "ml-0",

  /** @deprecated hover is on `prbadge` / `prBadge` — kept for call-site compose. */
  prbadgeLink: "hover:border-lane-pr hover:bg-lane-pr hover:text-white",

  nochange:
    "ml-auto border-[1.5px] border-dashed border-line-soft px-[0.45rem] py-[0.2rem] font-mono text-[0.64rem] tracking-[0.12em] uppercase text-ink-faint",

  archiveEmpty:
    "m-0 px-2 py-[2.6rem] text-center font-mono text-[0.7rem] tracking-[0.26em] uppercase text-ink-faint",

  pager:
    "mt-[1.1rem] flex flex-wrap items-center justify-between gap-x-[1.2rem] gap-y-[0.7rem]",

  pagerNote:
    "m-0 font-mono text-[0.68rem] tracking-[0.14em] uppercase text-ink-faint",

  pagerBtns: "flex gap-2",

  /* ---------- Dialogs (§4.9) ---------- */

  /**
   * Dialog panel shell. Backdrop uses the `dialog-backdrop` @utility in
   * styles.css (`::backdrop { background: var(--scrim) }`).
   */
  dialogPanel:
    "dialog-backdrop m-auto w-[min(92vw,32rem)] border-2 border-ink bg-paper p-0 text-ink shadow-none",

  dialogPanelNarrow: "w-[min(92vw,28rem)]",

  dialogHeader: "border-b border-line-ghost px-6 py-5",

  dialogHeaderCompact: "px-5 py-4",

  dialogKicker:
    "m-0 font-mono text-[0.62rem] font-bold tracking-[0.16em] uppercase text-ink-faint",

  dialogTitle:
    "mt-2 mb-0 font-display text-[clamp(1.2rem,2.4vw,1.45rem)] font-extrabold leading-[1.05] tracking-[-0.01em] uppercase text-ink",

  dialogTitleSm: "text-[1.1rem]",

  dialogTitlePath: "break-all tracking-[-0.01em] normal-case",

  dialogLede:
    "mt-[0.45rem] mb-0 font-display text-[0.92rem] leading-[1.4] text-ink-2",

  dialogBody: "grid gap-[1.15rem] px-6 py-5",

  dialogBodyCompact: "px-5 py-4",

  dialogFooter:
    "flex justify-end gap-3 border-t border-line-ghost bg-panel px-6 py-[0.9rem]",

  dialogFooterCompact: "px-5 py-3",

  dialogField:
    "grid min-w-0 gap-[0.4rem] font-display text-[0.88rem] font-semibold text-ink",

  dialogInput: cx(
    "w-full min-w-0 border-[1.5px] border-ink bg-paper px-[0.7rem] py-2",
    "text-[0.88rem] font-normal text-ink",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
    "disabled:cursor-not-allowed disabled:text-ink-faint disabled:opacity-70",
  ),

  dialogInputMono: "font-mono",

  dialogFieldMono:
    "[&>select]:font-mono [&>input:not([type=checkbox])]:font-mono",

  dialogFieldHint:
    "font-mono text-[0.68rem] font-normal tracking-[0.02em] text-ink-faint",

  dialogCheck:
    "flex flex-wrap items-center gap-3 font-display text-[0.88rem] font-semibold text-ink-2",

  dialogCheckInput: "h-4 w-4 accent-signal",

  dialogCheckHint: "ml-7 flex-[1_1_100%]",

  dialogStatusBlock: "grid gap-2",

  dialogStatusHead: "flex flex-wrap items-center justify-between gap-2",

  dialogStatusLabel:
    "m-0 font-mono text-[0.62rem] font-bold tracking-[0.12em] uppercase text-ink-faint",

  dialogStatusRow:
    "flex flex-wrap items-center justify-between gap-2 border border-line-ghost bg-panel px-3 py-2 font-mono text-[0.72rem] text-ink-2",

  dialogStatusRowStrong: "font-bold text-ink",

  dialogFieldset:
    "m-0 grid gap-3 border-[1.5px] border-ink px-4 pt-[0.9rem] pb-4",

  dialogFieldsetLegend:
    "px-[0.35rem] font-mono text-[0.62rem] font-bold tracking-[0.16em] uppercase text-ink-faint",

  dialogNote:
    "m-0 border border-line-ghost bg-panel px-3 py-[0.65rem] font-display text-[0.88rem] leading-[1.4] text-ink-2",

  dialogLoading: "m-0 font-display text-[0.88rem] text-ink-2",

  dialogTable: "w-full border-collapse text-left",

  dialogTableTh:
    "py-[0.4rem] pr-3 pl-0 font-display text-[0.88rem] font-semibold text-ink-2",

  dialogTableTd: "py-[0.4rem] font-mono text-[0.85rem] tabular-nums text-ink",

  dialogTableTr: "border-b border-line-ghost last:border-b-0",

  completionSummary:
    "mt-[0.4rem] border-[1.5px] border-ink bg-panel px-[0.65rem] py-2",

  completionSummaryP:
    "m-0 whitespace-pre-wrap font-display text-[0.88rem] leading-[1.4] text-ink-2",

  notFoundPanel:
    "mx-auto mt-12 max-w-[36rem] border-2 border-ink bg-panel p-8 text-center",

  /* ---------- Menus (§4.10) ---------- */

  menuPanel:
    "absolute top-full right-0 z-10 mt-1 min-w-[10rem] border-2 border-ink bg-panel py-1 shadow-none",

  menuItem: cx(
    "block w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left",
    "font-mono text-[0.68rem] font-bold tracking-[0.08em] uppercase text-ink-2",
    "hover:bg-[var(--plate-hover)] hover:text-ink",
    "focus-visible:bg-[var(--plate-hover)] focus-visible:text-ink",
    "disabled:cursor-wait disabled:opacity-50",
  ),

  menuItemDestructive:
    "hover:bg-lane-attention hover:text-[#151515] focus-visible:bg-lane-attention focus-visible:text-[#151515]",

  menuSep: "my-1 border-0 border-t border-line-ghost",

  /* ---------- Skeletons (§4.11) ---------- */

  skeleton:
    "block bg-line-ghost animate-[skeleton-pulse_1.2s_ease-in-out_infinite] motion-reduce:animate-none",

  /* ---------- Board shell + merged-PR stats (§4.2–4.4) ---------- */

  industrialShell: "mx-auto",

  mergedPrStats: "border-2 border-ink bg-paper text-ink",

  mergedPrStatsGrid: "grid grid-cols-5 max-[900px]:grid-cols-2",

  mergedPrStatsCell:
    "grid gap-1 border-l border-line-ghost px-[0.9rem] pt-[0.55rem] pb-[0.7rem] first:border-l-0 max-[900px]:odd:border-l-0 max-[900px]:[&:nth-child(n+3)]:border-t max-[900px]:[&:nth-child(n+3)]:border-line-ghost",

  mergedPrStatsLabel:
    "font-mono text-[0.68rem] font-semibold tracking-[0.14em] uppercase text-ink-2",

  mergedPrStatsNum:
    "font-display text-[clamp(2.1rem,3vw,2.9rem)] font-bold leading-none tabular-nums text-inherit",

  mergedPrStatsSkeleton:
    "my-[0.55rem] mx-[0.15rem] block h-[2.75rem] bg-line-ghost animate-[skeleton-pulse_1.2s_ease-in-out_infinite] motion-reduce:animate-none",

  /** Skeleton inside a stats cell (tighter margin) */
  mergedPrStatsSkeletonInCell: "my-[0.15rem] mx-0",

  mergedPrStatsBody: "px-[0.7rem] pt-[0.55rem] pb-[0.7rem]",

  pipelineControls:
    "mt-0 flex flex-wrap items-center justify-between gap-x-6 gap-y-[0.8rem] border-0 bg-transparent p-0 max-[900px]:grid max-[900px]:min-w-0",

  pipelineTabs: "m-0 flex min-w-0 flex-wrap border-0 p-0",

  repositoryFilters:
    "m-0 flex min-w-0 flex-wrap border-0 p-0 max-[900px]:w-full max-[900px]:max-w-full max-[900px]:flex-nowrap max-[900px]:overflow-x-auto max-[900px]:overscroll-x-contain max-[900px]:pb-[0.45rem] max-[900px]:[scroll-snap-type:inline_proximity] max-[900px]:[scrollbar-color:var(--ink)_var(--panel)] max-[900px]:[scrollbar-width:thin] max-[900px]:[touch-action:pan-x]",

  pipelineTab: cx(
    "relative inline-flex appearance-none items-center gap-[0.4rem]",
    "-ml-0.5 border-2 border-ink bg-paper px-4 py-2 first:ml-0",
    // Shared mini-plate rivets (top-left + top-right) — same recipe as plateMini.
    plateMiniRivets,
    "cursor-pointer font-display text-[0.72rem] font-bold tracking-[0.14em] uppercase text-ink-2 no-underline",
    "hover:text-ink",
    // Active route — navigation list (aria-current), not ARIA tabs (aria-selected).
    "aria-[current=page]:bg-ink aria-[current=page]:text-paper",
    // Keep right-hand rivets visible on the inverted ink fill (both themes).
    pipelineTabActiveRivets,
    "[&_svg]:h-[0.85rem] [&_svg]:w-[0.85rem] [&_svg]:shrink-0",
  ),

  pipelineTabSvg: "h-[0.85rem] w-[0.85rem] shrink-0",

  completedCardGrid:
    "mt-5 mb-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,34rem),1fr))] gap-[0.85rem] p-0",

  completedCardGridRow: "h-full content-start",

  repositoryFilter: cx(
    "relative appearance-none border border-line-soft bg-paper",
    "-ml-px px-3 py-[0.42rem] first:ml-0 first:border-l-0 last:border-r-0",
    "cursor-pointer font-mono text-[0.78rem] tracking-[0.03em] uppercase text-ink-2",
    "hover:border-ink hover:text-ink",
    "aria-pressed:border-ink aria-pressed:font-bold aria-pressed:text-ink aria-pressed:shadow-[inset_0_-3px_0_var(--ink)]",
    "max-[900px]:shrink-0 max-[900px]:grow-0 max-[900px]:basis-auto max-[900px]:[scroll-snap-align:start]",
  ),

  pipelineBoard:
    "mt-[1.6rem] grid gap-[0.55rem] max-[900px]:mt-[0.85rem] max-[900px]:gap-0",

  /**
   * Route spine + pot-belly furnace stops. Spine is a brass pneumatic tube
   * (see pipelineRouteSpine) centered on the furnace belly; stack sits above
   * and has room to vent smoke (overflow visible + top padding).
   */
  pipelineRoute: cx(
    "relative grid min-h-[3.6rem] grid-cols-6 items-end overflow-visible",
    "pt-[1.1rem] pb-[0.2rem] max-[900px]:hidden",
  ),

  /** Brass tube with dark bore + rivets — replaces the plain ink hairline. */
  pipelineRouteSpine: cx(
    "pointer-events-none absolute top-[calc(100%-1.25rem)] right-[calc(100%/12)] left-[calc(100%/12)]",
    "z-0 h-[0.7rem] -translate-y-1/2 rounded-[0.35rem]",
    "border-2 border-ink",
    "bg-[linear-gradient(180deg,#d4b483_0%,#b08d57_38%,#6b4f2a_100%)]",
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_-2px_0_rgb(0_0_0/0.25)]",
  ),

  pipelineRouteSpineBore: cx(
    "absolute top-[0.14rem] right-[0.28rem] bottom-[0.14rem] left-[0.28rem] rounded-[0.2rem]",
    "border border-black/50",
    "bg-[linear-gradient(180deg,#1a1a1a_0%,#2e2e2e_50%,#121212_100%)]",
  ),

  /** Sparse brass rivets along the tube (repeating dots). */
  pipelineRouteSpineRivets: cx(
    "absolute inset-0 rounded-[0.35rem] opacity-90",
    "bg-[radial-gradient(circle,#d4b483_0_1.2px,transparent_1.4px)]",
    "[background-size:1.15rem_100%] [background-position:0.35rem_50%] bg-repeat-x",
  ),

  /**
   * Pot-belly furnace stop (idle + animated phases via data-phase).
   * Outer shell keeps accessible name; chrome is aria-hidden.
   * Phase motion durations are applied from ROUTE_TRANSITION_MS / ROUTE_FED_MS
   * in pipeline-route.tsx (inline style) so JS timers and CSS stay lockstep.
   */
  laneRoundel: cx(
    "lane-furnace relative z-[1] mx-auto grid w-[2.45rem] justify-items-center",
    "origin-[50%_85%]",
  ),

  laneFurnaceStack: cx(
    "relative z-[2] mb-[-2px] h-[0.7rem] w-[0.48rem]",
    "border border-b-0 border-ink bg-[#3a3a3a]",
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]",
    // Brass chimney lip
    "before:absolute before:-top-[0.22rem] before:left-1/2 before:h-[0.26rem] before:w-[0.72rem]",
    "before:-translate-x-1/2 before:border before:border-ink",
    "before:bg-[linear-gradient(180deg,#d4b483_0%,#b08d57_45%,#6b4f2a_100%)] before:content-['']",
    // Small soot rim under the lip
    "after:absolute after:top-0 after:left-1/2 after:h-[0.12rem] after:w-[0.48rem]",
    "after:-translate-x-1/2 after:bg-black/35 after:content-['']",
  ),

  laneFurnaceBody: cx(
    "relative grid h-[2.35rem] w-[2.35rem] place-items-center rounded-full",
    "border-2 border-ink bg-[var(--lane-color)]",
    "font-mono text-[0.78rem] font-extrabold leading-none tracking-[0.02em] tabular-nums text-[var(--lane-text,#fff)]",
    // Belly shading — pot-belly depth
    "shadow-[inset_0_-10px_14px_rgb(0_0_0/0.28),inset_0_3px_0_rgb(255_255_255/0.18)]",
    "data-[lane=complete]:border-white data-[lane=complete]:outline data-[lane=complete]:outline-2 data-[lane=complete]:outline-ink",
  ),

  /** Faint dashed rivet band around the pot. */
  laneFurnaceBand: cx(
    "pointer-events-none absolute inset-[4px] z-0 rounded-full",
    "border border-dashed border-black/20",
  ),

  laneFurnaceCount: "relative z-[1] -translate-y-[0.15rem] tabular-nums",

  /** Dark firebox mouth at the bottom of the belly — traveler enter/exit. */
  laneFurnaceMouth: cx(
    "pointer-events-none absolute bottom-[0.14rem] left-1/2 z-[2] h-[0.55rem] w-[1.1rem]",
    "-translate-x-1/2 overflow-hidden rounded-[0.08rem_0.08rem_0.5rem_0.5rem]",
    "border-[1.5px] border-ink",
    "bg-[radial-gradient(ellipse_at_50%_30%,#3a2010_0%,#1a1410_70%)]",
    "shadow-[inset_0_2px_4px_rgb(0_0_0/0.6)]",
  ),

  /**
   * Slow fire simulation inside the mouth when the stop holds jobs.
   * Layers: coal bed + 3 staggered flame tongues (keyframes in styles.css).
   */
  laneFurnaceFire: cx(
    "pointer-events-none absolute inset-0 z-[1] opacity-0",
    "data-[lit=true]:opacity-100",
  ),

  /** Warm coal bed — slow breathe under the tongues. */
  laneFurnaceEmber: cx(
    "lane-furnace-ember absolute bottom-0 left-[10%] right-[10%] h-[55%]",
    "rounded-[40%] bg-[radial-gradient(ellipse_at_50%_80%,#ff8a2a_0%,#c04010_45%,transparent_75%)]",
    "opacity-0 data-[lit=true]:opacity-100",
  ),

  /** Individual flame tongue — data-i staggers phase in styles.css. */
  laneFurnaceFlame: cx(
    "lane-furnace-flame absolute bottom-[10%] w-[28%] rounded-[40%_40%_20%_20%/60%_60%_30%_30%]",
    "opacity-0 data-[lit=true]:opacity-100",
    "bg-[radial-gradient(ellipse_at_50%_80%,#ffe08a_0%,#ff6a1a_40%,#c02808_75%,transparent_90%)]",
    "mix-blend-screen",
  ),

  /**
   * Soft bloom above the mouth into the belly — only when lit.
   * Kept separate so the count stays readable.
   */
  laneFurnaceGlow: cx(
    "pointer-events-none absolute bottom-[0.35rem] left-1/2 z-[0] h-[0.55rem] w-[0.85rem]",
    "-translate-x-1/2 rounded-[50%]",
    "bg-[radial-gradient(ellipse_at_center,rgb(255_100_30/0.55)_0%,transparent_70%)]",
    "opacity-0 data-[lit=true]:opacity-100",
    "data-[lit=true]:animate-[furnace-fire-bloom_5.5s_ease-in-out_infinite]",
  ),

  /**
   * Stack smoke host — sits above the chimney lip. Puffs animate via
   * furnace-smoke-puff keyframes; --smoke-ms set inline from ROUTE_SMOKE_MS.
   */
  laneFurnaceSmoke: cx(
    "pointer-events-none absolute -top-[1.35rem] left-1/2 z-[5] h-[1.6rem] w-[1.4rem]",
    "-translate-x-1/2 overflow-visible",
  ),

  /** Stagger/offset via [data-i] rules in styles.css (furnace-smoke-puff). */
  laneFurnaceSmokePuff: cx(
    "lane-furnace-smoke-puff absolute bottom-0 left-1/2 h-[0.55rem] w-[0.55rem]",
    "rounded-full opacity-0",
    "bg-[radial-gradient(circle,rgb(200_200_196/0.92)_0%,rgb(140_140_136/0.4)_55%,transparent_72%)]",
  ),

  /** Coal-lump traveler rolling along the route spine. */
  routeTraveler: cx(
    "pointer-events-none absolute top-[calc(100%-1.25rem)] z-[4] h-[0.65rem] w-[0.7rem]",
    "-translate-x-1/2 -translate-y-1/2 rounded-[45%_55%_50%_50%]",
    "border-[1.5px] border-ink",
    "bg-[radial-gradient(circle_at_30%_30%,#5a4a3a_0%,#1a1410_70%)]",
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]",
    // Ember highlight
    "after:absolute after:top-[22%] after:left-[18%] after:h-[30%] after:w-[35%] after:rounded-full",
    "after:bg-[rgb(255_100_30/0.45)] after:blur-[0.5px] after:content-['']",
  ),

  pipelineLanes:
    "grid grid-cols-6 items-stretch gap-0.5 border-2 border-ink bg-ink max-[900px]:block max-[900px]:gap-0 max-[900px]:border-0 max-[900px]:bg-transparent",

  pipelineLane: cx(
    "relative flex min-h-[23rem] min-w-0 flex-col bg-[var(--lane-bed)]",
    "max-[900px]:hidden max-[900px]:min-h-[18rem] max-[900px]:border-2 max-[900px]:border-ink",
    "max-[900px]:data-[mobile-active=true]:flex",
  ),

  laneHeader: cx(
    "sticky top-0 z-[5] isolate flex min-h-[5.25rem] overflow-hidden border-b-2 border-ink",
    "bg-[#252827] p-[3px] text-[var(--lane-text,#fff)]",
    "[background-image:linear-gradient(90deg,#151817,#4a4e4b_48%,#1c1f1e)]",
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.45),inset_0_-1px_0_rgb(0_0_0/0.8)]",
    "max-[900px]:static max-[900px]:min-h-16",
  ),

  laneHeaderSheet: cx(
    "relative flex min-w-0 flex-1 items-end overflow-hidden border border-black/70",
    "bg-[var(--lane-color)] pt-[0.72rem] pr-[1.15rem] pb-[0.72rem] pl-[1.15rem]",
    "[background-image:linear-gradient(112deg,transparent_0_24%,rgb(255_255_255/0.06)_28%,rgb(255_255_255/0.34)_34%,rgb(255_255_255/0.05)_40%,transparent_45%_100%),repeating-linear-gradient(0deg,rgb(255_255_255/0.055)_0_1px,rgb(0_0_0/0.035)_1px_2px,transparent_2px_4px),linear-gradient(180deg,rgb(255_255_255/0.28)_0%,transparent_38%,rgb(0_0_0/0.17)_100%)]",
    "[background-blend-mode:screen,overlay,normal]",
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.55),inset_0_-3px_4px_rgb(0_0_0/0.28),inset_1px_0_0_rgb(255_255_255/0.15),0_1px_2px_rgb(0_0_0/0.8)]",
  ),

  laneHeaderGrain:
    "pointer-events-none absolute inset-0 z-[1] bg-[length:160px_120px] opacity-20 mix-blend-soft-light [background-image:repeating-linear-gradient(97deg,transparent_0_2px,rgb(255_255_255/0.1)_2px_3px,transparent_3px_7px),repeating-linear-gradient(3deg,rgb(0_0_0/0.055)_0_1px,transparent_1px_5px)]",

  laneHeaderCode:
    "absolute top-[0.48rem] left-[1.25rem] z-[3] font-mono text-[0.48rem] font-bold tracking-[0.14em] opacity-55",

  laneHeaderRivet: cx(
    "absolute z-[4] h-[9px] w-[9px] rounded-full",
    "[background-image:radial-gradient(circle_at_31%_25%,#fff_0_7%,transparent_8%),radial-gradient(circle_at_36%_30%,#d8ddda_0_16%,#89908c_38%,#343837_67%,#aeb4b1_88%)]",
    "shadow-[0_0_0_1px_rgb(0_0_0/0.7),0_1px_1px_rgb(0_0_0/0.75),inset_-1px_-1px_1px_rgb(0_0_0/0.55)]",
  ),

  laneTitle:
    "relative z-[3] m-0 whitespace-nowrap font-display text-[clamp(0.82rem,1.05vw,1.18rem)] font-[950] leading-[0.86] tracking-[-0.035em] uppercase text-[var(--lane-text,#fff)] [text-shadow:0_1px_0_rgb(255_255_255/0.25),0_-1px_0_rgb(0_0_0/0.3),0_2px_3px_rgb(0_0_0/0.12)] max-[900px]:text-[1.18rem]",

  laneStack:
    "m-0 grid min-w-0 flex-[1_1_auto] list-none content-start gap-[0.55rem] p-[0.55rem]",

  laneEmpty:
    "m-2 border-t border-dashed border-[rgb(21_21_21/0.35)] pt-4 font-mono text-[0.7rem] font-bold leading-[1.4] tracking-[0.08em] uppercase text-[#4a4a4a]",

  queueHint:
    "m-[0.55rem] mt-auto grid gap-[0.45rem] border-2 border-ink bg-lane-queue px-[0.7rem] py-[0.65rem] text-[#151515]",

  queueHintText:
    "m-0 font-display text-[0.9rem] font-medium leading-[1.35] text-[#151515]",

  /** Inline mono chip for the ready-for-agent label name. */
  queueHintCode:
    "rounded-none border border-[#151515] bg-[#151515] px-[0.28rem] py-[0.05rem] font-mono text-[0.72rem] font-bold tracking-[0.02em] text-lane-queue",

  /**
   * Inline nav link to /repos inside the queue empty-state hint ("your
   * repos"). Underline + focus ring so it reads as a control on the yellow
   * lane card.
   */
  queueHintLink:
    "text-[#151515] underline underline-offset-2 hover:decoration-2 hover:decoration-signal focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#151515]",

  /**
   * Compact static mock of the repos issue ⋮ menu (Implement now /
   * Implement locally) — decorative, under the hint copy. Matches the
   * industrial menu chrome (ink border, mono uppercase items, ⋮ trigger).
   */
  queueHintMenuIllus: "mt-[0.1rem] flex w-fit flex-col items-end gap-[0.2rem]",

  queueHintMenuKebab:
    "inline-flex h-6 w-6 shrink-0 items-center justify-center border border-[#151515] bg-[var(--panel,#ffffff)] text-[#151515]",

  queueHintMenuPanel:
    "min-w-[9.5rem] border-2 border-[#151515] bg-[var(--panel,#ffffff)] py-0.5 shadow-none",

  queueHintMenuItem:
    "block px-2.5 py-1.5 font-mono text-[0.62rem] font-bold tracking-[0.08em] uppercase text-[#151515]",

  jobTicket: cx(
    // minmax(0,1fr): single column may shrink below long mono min-content so
    // runtime lines / chips ellipsize inside the ticket instead of overflowing.
    "relative grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[0.4rem] rounded-none border-[1.5px] border-ink",
    // Warm cream slip (lane-bed mix) — not pure white, not brushed metal.
    // Same parchment fill in every lane so Build/Review/PR match Merged.
    "bg-[var(--ticket-fill)]",
    "px-[0.65rem] py-[0.55rem] pr-[0.65rem] pb-[0.7rem] pl-[0.95rem]",
    "shadow-[inset_6px_0_0_var(--ticket-color,var(--ink))]",
    "data-[lane=complete]:shadow-[inset_6px_0_0_var(--ticket-color,var(--lane-merged)),inset_8px_0_0_var(--merged-halo)]",
  ),

  /**
   * Ticket still parked in the source lane while the route traveler is en
   * route — faded, desaturated. Pair with the HTML `inert` attribute on the
   * ticket so keyboard focus cannot reach controls (pointer-events alone
   * is not enough).
   */
  jobTicketDeparting: cx(
    "pointer-events-none select-none opacity-40 grayscale",
    "border-ink-faint shadow-[inset_6px_0_0_var(--ink-faint)]",
  ),

  /**
   * Destination ticket during absorb — marker only. All arrive motion stays on
   * the `ticket-arrive` keyframe + inline duration (ROUTE_TRANSITION_MS.absorb).
   * Do not add layout/transform utilities here; opacity-only is required so the
   * lane stack is undisturbed. prefers-reduced-motion collapses the keyframe.
   */
  jobTicketArriving: "job-ticket-arriving",

  jobTicketRepo:
    "m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.68rem] font-normal leading-[1.2] tracking-[0.1em] uppercase text-ink-faint",

  jobTicketTitle:
    "m-0 block min-w-0 max-w-full font-display text-[1.06rem] font-semibold leading-[1.3] text-ink no-underline [overflow-wrap:anywhere]",

  jobTicketTitleLink:
    "hover:text-ink hover:underline hover:decoration-signal hover:decoration-2 hover:underline-offset-[3px]",

  jobTicketNum: "font-mono text-[0.8rem] text-ink-2",

  jobTicketStatus: "flex min-w-0 items-center justify-between gap-[0.4rem]",

  jobTicketState: "m-0 min-w-0 max-w-full truncate",

  jobTicketRuntime: "mt-0 grid min-w-0 max-w-full gap-[0.2rem] border-t-0 pt-0",

  jobTicketRuntimeLine:
    "m-0 min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.8rem] leading-[1.4] tracking-[0.04em] text-ink-faint",

  jobTicketSession:
    "min-w-0 max-w-full cursor-pointer border-0 bg-transparent p-0 text-left font-inherit text-ink-2 underline underline-offset-2 hover:text-ink",

  pipelineList:
    "mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] border-2 border-ink bg-panel p-3",

  pipelineListEmpty:
    "mt-6 mb-0 border-0 bg-transparent px-[0.4rem] py-[1.6rem] text-center font-mono text-[0.7rem] font-normal tracking-[0.14em] uppercase text-ink-faint",

  laneSwitcher:
    "m-0 hidden min-w-0 border-0 p-0 max-[900px]:mt-4 max-[900px]:grid max-[900px]:w-full max-[900px]:max-w-full max-[900px]:grid-cols-3 max-[900px]:gap-[0.35rem] max-[900px]:border-0 max-[900px]:bg-transparent max-[900px]:p-0",

  laneSwitch: cx(
    "inline-flex appearance-none items-center justify-center gap-[0.35rem]",
    "min-w-0 border-2 border-ink bg-[var(--plate)]",
    laneSwitchRivets,
    "shadow-[inset_0_1px_0_var(--plate-hi),inset_0_-2px_0_var(--plate-lo)]",
    "px-2 py-[0.46rem]",
    "cursor-pointer font-mono text-[0.62rem] font-bold tracking-[0.08em] uppercase text-[var(--plate-ink)]",
    "hover:bg-[var(--plate-hover)]",
    "aria-pressed:bg-ink aria-pressed:bg-none aria-pressed:text-paper aria-pressed:shadow-none",
    "max-[900px]:min-h-[2.75rem] max-[900px]:min-w-0 max-[900px]:whitespace-normal max-[900px]:px-[0.35rem]",
  ),

  laneSwitchSwatch:
    "h-[0.55rem] w-[0.55rem] shrink-0 border border-ink bg-[var(--lane-color,var(--ink))] aria-pressed:border-paper",

  /**
   * Swatch border when parent lane-switch is pressed.
   * Prefer: parent `aria-pressed` + `group` / `group-aria-pressed:border-paper`.
   */
  laneSwitchSwatchPressed: "border-paper",

  /* ---------- Status tags (§5.1) ---------- */

  // Base is layout/type only — each tone owns border/fill/ink so Tailwind
  // cascade does not leave plain `bg-transparent` winning over alarm fill.
  // max-w-full + truncate keeps long labels inside narrow kanban tickets.
  statusTag:
    "inline-flex max-w-full min-w-0 items-center overflow-hidden text-ellipsis whitespace-nowrap border-[1.5px] px-[0.4rem] py-[0.18rem] font-mono text-[0.66rem] font-bold leading-[1.2] tracking-[0.12em] uppercase no-underline",

  statusTagAlarm: "border-lane-attention bg-lane-attention text-[#151515]",

  statusTagHold: "border-dashed border-ink bg-transparent text-ink-2",

  statusTagComplete: "border-ink bg-ink text-paper",

  statusTagGhost: "border-dashed border-ink-faint bg-transparent text-ink-2",

  statusTagPlain: "border-ink bg-transparent text-ink-2",

  statusMessage: "mt-[0.35rem] mb-0 font-mono text-[0.6rem] text-ink-2",

  statusMessageAlarm: "text-ink",

  statusMessageMark: "text-lane-attention",

  /* ---------- Journey-leg chips (board §5.2) — see also `leg*` above ---------- */

  legSummary: cx(
    "inline-flex max-w-full min-w-0 cursor-pointer items-center gap-[0.35rem]",
    "overflow-hidden border-[1.5px] border-ink bg-[var(--leg-lane,var(--lane-build))] px-[0.38rem] py-[0.16rem]",
    "font-mono text-[0.56rem] font-bold tracking-[0.06em] uppercase whitespace-nowrap text-[var(--leg-on,#fff)]",
    "hover:brightness-105",
  ),

  /* ---------- Icon buttons (§5.4) ---------- */

  /**
   * Default rest state is full ink (not faint) so kebabs / collapse / refresh
   * stay legible on metallic repo cards and other mid-tone panels.
   */
  iconBtn: cx(
    "inline-flex h-7 w-7 shrink-0 items-center justify-center border border-ink bg-transparent p-0",
    "cursor-pointer text-ink",
    "transition-[border-color,color,background-color] duration-100 ease-in-out",
    "hover:bg-[var(--plate-hover)]",
    "disabled:cursor-wait disabled:opacity-55",
    "[&_svg]:h-[0.9rem] [&_svg]:w-[0.9rem]",
  ),

  /**
   * Borderless icon control for inline copy next to mono runtime lines.
   * Keeps hit target; hover plate wash only (no ink box).
   */
  iconBtnBare: cx(
    "inline-flex h-7 w-7 shrink-0 items-center justify-center border-0 bg-transparent p-0",
    "cursor-pointer text-ink-2",
    "transition-[color,background-color] duration-100 ease-in-out",
    "hover:bg-[var(--plate-hover)] hover:text-ink",
    "disabled:cursor-wait disabled:opacity-55",
    "[&_svg]:h-[0.9rem] [&_svg]:w-[0.9rem]",
  ),

  iconBtnArmed:
    "border-[1.5px] border-lane-attention text-lane-attention hover:bg-lane-attention hover:text-[#151515]",

  iconBtnPaused: "border-ink text-ink",

  /** Success flash for Copy — PR-green glyph (no border box). */
  iconBtnCopied: "text-lane-pr",

  iconBtnSvg: "h-[0.9rem] w-[0.9rem]",

  /* ---------- PR badge board chrome (§5.5) ---------- */

  /** Outline stamp — ink border, transparent fill (less loud than solid black). */
  prBadge: cx(
    "inline-flex items-center whitespace-nowrap border-[1.5px] border-ink bg-transparent",
    "px-2 py-[0.2rem]",
    "font-mono text-[0.68rem] font-bold tracking-[0.06em] uppercase text-ink no-underline",
    "hover:border-lane-pr hover:bg-lane-pr hover:text-white",
  ),

  /* ---------- Primary plate (§5.3) ---------- */

  platePrimary: cx(
    "inline-flex items-center justify-center gap-[0.4rem] border-2 border-ink",
    "bg-ink px-[0.95rem] py-[0.46rem] text-paper",
    "font-mono text-[0.68rem] font-bold tracking-[0.12em] uppercase no-underline",
    "cursor-pointer transition-[background-color,color] duration-100 ease-in-out",
    "hover:bg-signal hover:text-[#151515]",
    "disabled:cursor-not-allowed disabled:opacity-55",
    "disabled:aria-busy:cursor-wait",
  ),

  /* ---------- Stamps (§5.6) ---------- */

  stamp:
    "inline-flex items-center whitespace-nowrap border-[1.5px] border-ink-faint bg-transparent px-[0.45rem] py-[0.2rem] font-mono text-[0.56rem] font-bold leading-[1.2] tracking-[0.12em] uppercase text-ink-2",

  stampClosed: "border-dashed border-ink-faint bg-transparent text-ink-2",

  stampNeutral: "border-dashed border-ink-faint bg-transparent text-ink-2",

  stampBlocked: "border-solid border-lane-queue bg-lane-queue text-[#151515]",

  /* ---------- Repos page + blank slate (§4.6–4.7) ---------- */

  repoCards: "grid grid-cols-1 gap-6",

  /**
   * Repo card. Dark-friendly solid panel; light theme adds brushed metal
   * via `in-[html[data-theme=light]]:` arbitrary variant (shared with archiveRow).
   */
  repoCard: cx(
    "relative min-w-0 border-[1.5px] border-ink bg-panel px-[1.1rem] pt-4 pb-[1.15rem]",
    cardMetalLight,
  ),

  repoCardHead:
    "flex flex-wrap items-start justify-between gap-x-4 gap-y-[0.6rem]",

  repoCardTitle:
    "m-0 flex min-w-0 max-w-full items-baseline gap-[0.55rem] font-display text-[1.06rem] font-semibold leading-[1.25] tracking-[-0.01em]",

  repoCardLink:
    "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-ink no-underline hover:text-ink hover:underline hover:decoration-signal hover:decoration-2 hover:underline-offset-[3px]",

  repoCardPrCount:
    "shrink-0 font-mono text-[0.72rem] font-semibold tracking-[0.04em] tabular-nums text-ink-faint",

  repoCardControls: "flex shrink-0 items-center gap-1",

  repoMeta:
    "mt-[0.95rem] mb-0 grid gap-x-8 gap-y-[0.55rem] border-y border-line-ghost py-3 sm:grid-cols-2",

  repoMetaRow: "flex min-w-0 items-baseline gap-2",

  repoMetaDt:
    "m-0 shrink-0 font-mono text-[0.75rem] font-bold tracking-[0.1em] uppercase text-ink-2",

  repoMetaDd:
    "m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.9rem] font-normal tracking-[0.01em] text-ink",

  guidanceCode:
    "inline-block max-w-full overflow-x-auto border-[1.5px] border-ink bg-paper px-[0.4rem] py-[0.18rem] align-baseline font-mono text-[0.78rem] font-medium text-ink",

  repoIssues: "mt-[1.1rem]",

  repoIssuesHead: "mb-[0.55rem] flex items-baseline justify-between gap-3",

  repoIssuesKicker:
    "m-0 font-mono text-[0.62rem] font-bold tracking-[0.22em] uppercase text-ink-faint",

  repoIssuesList: "m-0 grid list-none gap-0 p-0",

  repoIssuesEmpty:
    "m-0 font-mono text-[0.68rem] tracking-[0.08em] uppercase text-ink-faint",

  repoIssue:
    "min-w-0 border-t border-line-ghost py-[0.55rem] first:border-t-0 first:pt-[0.15rem]",

  repoIssueRow:
    "grid grid-cols-[2.4rem_minmax(0,1fr)_auto] items-start gap-x-[0.55rem] gap-y-[0.45rem]",

  repoIssueNum:
    "font-mono text-[0.72rem] font-semibold leading-[1.45] text-ink-2",

  repoIssueTitle:
    "m-0 block font-display text-[0.95rem] font-medium leading-[1.3] text-ink no-underline [overflow-wrap:anywhere]",

  repoIssueTitleLink:
    "hover:text-ink hover:underline hover:decoration-signal hover:decoration-2 hover:underline-offset-[3px]",

  repoIssueAuthor:
    "mt-[0.15rem] block font-mono text-[0.62rem] tracking-[0.06em] text-ink-faint",

  repoIssueActions: "flex shrink-0 items-center gap-[0.35rem]",

  repoIssueBlockedBy:
    "mt-[0.4rem] mb-0 pl-[2.95rem] font-mono text-[0.62rem] tracking-[0.04em] text-ink-2",

  repoIssueBlockedByLink:
    "font-semibold text-ink underline underline-offset-2 hover:decoration-2 hover:decoration-signal",

  repoIssueError: "mt-[0.4rem] mb-0 ml-[2.95rem]",

  parentIssueError: "mx-[0.65rem] mt-[0.45rem] mb-[0.55rem]",

  parentIssue: "my-[0.35rem] min-w-0 border-[1.5px] border-ink bg-panel",

  parentIssueSummary:
    "grid cursor-pointer list-none grid-cols-[2.4rem_minmax(0,1fr)_auto] items-start gap-x-[0.55rem] gap-y-[0.45rem] px-[0.65rem] py-[0.55rem] [&::-webkit-details-marker]:hidden",

  parentIssueClosedCount:
    "font-mono text-[0.62rem] font-bold tracking-[0.1em] uppercase text-ink-faint",

  parentIssueSummaryActions: "flex shrink-0 items-center gap-[0.4rem]",

  parentIssueChevron:
    "h-[0.85rem] w-[0.85rem] text-ink transition-transform duration-100 ease-in-out",

  /**
   * Rotate chevron when details is open.
   * Apply via group-open on parent, or compose when open.
   */
  parentIssueChevronOpen: "rotate-180",

  parentIssueChildren: cx(
    "relative m-0 grid list-none gap-0 border-t border-line-ghost",
    "px-[0.65rem] pt-[0.15rem] pr-[0.65rem] pb-[0.55rem] pl-[0.85rem]",
    "before:absolute before:top-[0.35rem] before:bottom-[0.45rem] before:left-0 before:w-0.5 before:bg-line-soft before:content-['']",
  ),

  lifecycleInset:
    "mt-2 mb-0 ml-[2.95rem] min-w-0 max-w-full border-[1.5px] border-ink bg-panel px-[0.65rem] py-[0.55rem]",

  blankSlate:
    "grid justify-items-center border-2 border-dashed border-ink bg-panel px-6 pt-[2.4rem] pb-[2.2rem] text-center sm:px-10 sm:pt-[2.8rem] sm:pb-10",

  blankSlateTitle:
    "mt-[0.7rem] mb-0 font-display text-[clamp(1.35rem,2.6vw,1.85rem)] font-extrabold leading-[1.05] tracking-[-0.01em] uppercase text-ink",

  blankSlateForm:
    "mt-[1.4rem] flex w-full max-w-[36rem] flex-col gap-3 text-left",

  blankSlateFormFlush: "mt-0",

  blankSlatePathRow: "flex flex-col gap-2 sm:flex-row sm:items-stretch",

  blankSlateInput: cx(
    "min-w-0 flex-[1_1_auto] border-[1.5px] border-ink bg-paper px-[0.7rem] py-[0.55rem]",
    "font-mono text-[0.85rem] text-ink",
    "placeholder:text-ink-faint",
    "disabled:opacity-60",
  ),

  blankSlateActions: "flex shrink-0 gap-[0.45rem]",

  blankSlateFieldset:
    "m-0 grid gap-3 border-[1.5px] border-ink px-4 pt-[0.9rem] pb-4",

  blankSlateFieldsetLegend:
    "px-[0.35rem] font-mono text-[0.62rem] font-bold tracking-[0.16em] uppercase text-ink-faint",

  blankSlateField:
    "grid gap-[0.35rem] font-display text-[0.85rem] font-semibold text-ink-2",

  blankSlateFieldControl:
    "border-[1.5px] border-ink bg-paper px-[0.65rem] py-2 font-mono text-[0.85rem] font-normal text-ink",

  blankSlateHint:
    "m-0 font-mono text-[0.62rem] tracking-[0.04em] text-ink-faint",

  blankSlateDivider:
    "mt-[1.6rem] flex w-full max-w-[36rem] items-center gap-[0.85rem] before:h-px before:flex-[1_1_auto] before:bg-line-ghost before:content-[''] after:h-px after:flex-[1_1_auto] after:bg-line-ghost after:content-['']",

  blankSlateDividerSpan:
    "font-mono text-[0.62rem] font-bold tracking-[0.18em] uppercase text-ink-faint",

  blankSlateCli:
    "mt-4 mb-0 max-w-[36rem] font-display text-[0.9rem] font-medium text-ink-2",

  /** guidance-code inside blank-slate (tighter padding, larger type) */
  blankSlateGuidanceCode: "mt-3 px-[0.7rem] py-[0.45rem] text-[0.82rem]",

  repoCardSkeleton:
    "grid gap-3 border-[1.5px] border-line-ghost bg-panel px-[1.1rem] py-4",
} as const satisfies Record<string, string>

/*
 * CSS that cannot (or should not) be fully expressed as utilities:
 *
 * 1. dialog-panel::backdrop { background: var(--scrim) }
 *    — ::backdrop is not available as a Tailwind variant on the dialog element
 *      in a portable way; keep in styles.css.
 *
 * 2. @keyframes skeleton-pulse, furnace-*, route-*, work-item-reset-*
 *    — Keyframes stay in styles.css; utilities reference
 *      animate-[skeleton-pulse_1.2s_ease-in-out_infinite]. Furnace / traveler
 *      motion for #737 uses inline style.animation with ROUTE_*_MS durations.
 *
 * 3. Parent-only BEM modifiers that only style descendants
 *    (banner--alarm / banner--guidance → .banner-tag):
 *    — Exported as empty parent keys + child composition keys
 *      (bannerTagAlarm, bannerTagGuidance). Wire at the tag element.
 *
 * 4. .parent-issue[open] .parent-issue-chevron
 *    — Use group-open:rotate-180 on the chevron when parent has `group`,
 *      or parentIssueChevronOpen when details is open.
 *
 * 5. .lane-switch[aria-pressed=true] .lane-switch-swatch
 *    — Prefer group + group-aria-pressed:border-paper on the swatch,
 *      or laneSwitchSwatchPressed when pressed.
 *
 * 6. Nested form control selectors
 *    (.dialog-field > select/input, .blank-slate-field select/input):
 *    — Styles live on dialogInput / blankSlateFieldControl; apply to the
 *      control element rather than relying on descendant CSS.
 *
 * 7. .blank-slate .guidance-code size override
 *    — Use blankSlateGuidanceCode composed with guidanceCode.
 *
 * 8. prefers-reduced-motion for skeleton
 *    — Covered via motion-reduce:animate-none (Tailwind).
 *
 * 9. Global base layer (body, selection, focus-visible, mast :focus-visible)
 *    — Intentionally left in styles.css @layer base (global defaults only).
 */
