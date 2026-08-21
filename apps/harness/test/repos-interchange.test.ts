import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const uiSource = () =>
  readFileSync(join(import.meta.dir, "../src/ui.ts"), "utf8")

const sliceBetweenMarkers = (
  source: string,
  startMarker: string,
  endMarker: string,
): string => {
  const start = source.indexOf(startMarker)
  if (start < 0) {
    throw new Error(`Start marker not found: ${startMarker}`)
  }
  const end = source.indexOf(endMarker, start)
  if (end < 0) {
    throw new Error(`End marker not found after ${startMarker}: ${endMarker}`)
  }
  return source.slice(start, end)
}

/**
 * Interchange phase 4 — repos page + blank slate (issue #703 / §4.6–4.7).
 * Structural + design-token contract tests; no behavior changes.
 */
describe("Interchange phase 4: repos page + blank slate", () => {
  test("repo cards use a forged frame, display title, mono PR count, icon controls", () => {
    const source = homeSource()
    // Card chrome only (settings dialog stays on Ledger until phase 5).
    const head = sliceBetweenMarkers(
      source,
      "className={ui.repoCard}",
      "<dialog",
    )
    expect(head).toContain("ui.repoCardTitle")
    expect(head).toContain("ui.repoCardLink")
    expect(head).toContain("ui.repoCardPrCount")
    expect(head).toContain("ui.repoCardControls")
    expect(head).toContain("ui.iconBtn")
    expect(head).not.toContain("font-serif")
    expect(head).not.toContain("border-t-2 border-ink-soft")
    // Pause/armed classes are composed above the JSX return.
    expect(source).toContain("ui.iconBtnPaused")
    expect(source).toContain("ui.iconBtnArmed")
    expect(source).toContain("pauseButtonClassName")
    expect(source).toContain("className={ui.repoCard}")

    const ui = uiSource()
    expect(ui).toContain("repoCard:")
    // Shared forged frame shell carries the hard ink border + dark casing.
    expect(ui).toContain(
      '"relative min-w-0 border-2 border-ink bg-[#252827] p-[3px]"',
    )
    const cardFrame = sliceBetweenMarkers(ui, "repoCard: cx(", "repoCardInner:")
    expect(cardFrame).toContain("repoCardFrameShell")
    expect(cardFrame).toContain("repoCardFrameCasing")
    expect(cardFrame).not.toContain("border-[1.5px]")
    expect(ui).toContain("repoCardInner:")
    expect(ui).toContain("repoCardTitle:")
    expect(ui).toMatch(/repoCardTitle:[\s\S]*?text-\[1\.06rem\]/)
    expect(ui).toMatch(/repoCardLink:[\s\S]*?hover:decoration-signal/)
  })

  test("repo card uses a Pipeline-style forged frame and six-lane top rail", () => {
    const source = homeSource()
    const head = sliceBetweenMarkers(
      source,
      "className={ui.repoCard}",
      "<dialog",
    )
    // One decorative rail per populated card, above the body panel.
    expect(head).toContain("<RepoCardRail />")
    expect(head).toContain("className={ui.repoCardInner}")
    // Rail reuses canonical lane order/colors (no drift from Pipeline).
    expect(source).toContain("PIPELINE_LANES")
    expect(source).toContain('from "./pipeline-lanes.js"')

    const ui = uiSource()
    expect(ui).toContain("repoCardInner:")
    expect(ui).toMatch(/repoCardInner:[\s\S]*?bg-panel/)
    expect(ui).toContain("repoCardRail:")
    expect(ui).toContain("repoCardRailSegment:")
    expect(ui).toMatch(/repoCardRail:[\s\S]*?flex/)
    expect(ui).toMatch(/repoCardRailSegment:[\s\S]*?flex-1/)
    // Forged frame: dark metal casing via the shared shell, no 1.5px border.
    const frame = sliceBetweenMarkers(ui, "repoCard: cx(", "repoCardInner:")
    expect(frame).toContain("repoCardFrameShell")
    expect(frame).not.toContain("border-[1.5px]")
  })

  test("meta table is hairline two-column mono dt/dd with harness-default annotations", () => {
    const meta = sliceBetweenMarkers(
      homeSource(),
      "className={ui.repoMeta}",
      "</dl>",
    )
    expect(meta).toContain("ui.repoMetaRow")
    expect(meta).toContain("Harness default (")
    expect(
      Array.from(meta.matchAll(/<dt>([^<]+)<\/dt>/g), (match) => match[1]),
    ).toEqual([
      "Path",
      "Checkout",
      "Agent Backend",
      "Include all Issue Authors",
      "Build model",
      "Review model",
      "Wait for ready checks",
      "Merge Policy",
    ])

    const ui = uiSource()
    expect(ui).toContain("repoMeta:")
    expect(ui).toMatch(/repoMeta:[\s\S]*?border-y/)
    expect(ui).toMatch(/repoMeta:[\s\S]*?border-line-ghost/)
    expect(ui).toMatch(/repoMeta:[\s\S]*?sm:grid-cols-2/)
  })

  test("credential banners use Attention tag, primary-plate CTAs, guidance-code chips", () => {
    const body = sliceBetweenMarkers(
      homeSource(),
      "className={ui.repoMeta}",
      "function RepositoryIssues(",
    )
    expect(body).toContain('tag="Attention"')
    expect(body).toContain("GitHub token required")
    expect(body).toContain("GitLab authentication required")
    expect(body).toContain("ui.platePrimary")
    expect(body).toContain("Create GitHub token")
    expect(body).toContain("Store in Keymaxxer")
    expect(body).toContain("Actions: Read and write")
    expect(body).toContain("Workflows: Read and write")
    expect(body).toContain(
      "Already-created tokens are not upgraded automatically",
    )
    expect(body).toContain("ui.guidanceCode")

    const ui = uiSource()
    expect(ui).toContain("platePrimary:")
    expect(ui).toContain("guidanceCode:")
    // Riveted stamped-plate twin of mini (not solid-ink primary).
    expect(ui).toMatch(/platePrimary:[\s\S]*?--plate/)
    expect(ui).toMatch(/platePrimary:[\s\S]*?hover:bg-\[var\(--plate-hover\)\]/)
  })

  test("relevant issues use ticket rows; Closed dashed stamp; Blocked Queue-yellow without wash", () => {
    const issues = sliceBetweenMarkers(
      homeSource(),
      "function RepositoryIssueRow(",
      "export function JobsCardSkeleton(",
    )
    expect(issues).toContain("ui.repoIssue")
    expect(issues).toContain("ui.repoIssueNum")
    expect(issues).toContain("ui.repoIssueTitleInline")
    expect(issues).toContain("ui.repoIssueTitleRow")
    expect(issues).toContain("ui.repoIssueImplementBtn")
    expect(issues).toContain("ui.repoIssueImplementIcon")
    expect(issues).toContain("disabled={implementPending}")
    const implementAction = sliceBetweenMarkers(
      issues,
      "{canImplement && (",
      "{issue.issueAuthor !== null",
    )
    expect(implementAction).toContain("onClick={startImplementNow}")
    expect(implementAction).not.toContain('aria-haspopup="menu"')
    expect(implementAction).not.toContain('role="menu"')
    expect(implementAction).not.toContain("Implement locally")
    const actionHandlers = sliceBetweenMarkers(
      issues,
      "const startImplementNow = () => {",
      "return (",
    )
    expect(actionHandlers).toContain("implementLocally.reset()")
    expect(actionHandlers).toContain("queueIssue.reset()")
    expect(actionHandlers).toContain("implementNow.mutate()")
    expect(actionHandlers).toContain("implementLocally.mutate()")
    expect(actionHandlers).toContain("queueIssue.mutate()")
    expect(actionHandlers).toContain("setImplementWithOpen(true)")
    expect(issues).toContain("<IssueActionsMenu")
    expect(issues).toContain("onImplementWith={startImplementWith}")
    expect(issues).toContain("<ImplementWithIssueDialog")
    expect(issues.indexOf("ui.repoIssueImplementBtn")).toBeLessThan(
      issues.indexOf("ui.repoIssueActions"),
    )
    expect(issues.indexOf("ui.repoIssueActions")).toBeLessThan(
      issues.indexOf("<IssueActionsMenu"),
    )
    expect(issues).toContain("ui.repoIssueAuthor")
    expect(issues).toContain("ui.stamp")
    expect(issues).toContain("ui.stampClosed")
    expect(issues).toContain("Closed")
    expect(issues).toContain("ui.stampBlocked")
    expect(issues).toContain("Blocked")
    expect(issues).toContain("ui.repoIssueBlockedBy")
    expect(issues).toContain("Blocked by")
    // Companions (lifecycle / error / blocked-by) live in the title column so
    // long GitLab iids can widen the number track without a fixed rem gutter.
    // Title column is a flow <div> (not <span>) so Banner / lifecycle / <p> are valid.
    const titleColumn = sliceBetweenMarkers(
      issues,
      '<div className="min-w-0">',
      "className={ui.repoIssueActions}",
    )
    expect(titleColumn).toContain("WorkItemLifecycleStatus")
    expect(titleColumn).toContain("ui.repoIssueError")
    expect(titleColumn).toContain("ui.repoIssueBlockedBy")
    // Old amber row-wash language is dropped.
    expect(issues).not.toContain("bg-amber-wash")
    expect(issues).not.toContain("border-sepia")
    expect(issues).not.toContain("text-sepia")
    expect(issues).not.toContain("font-serif")

    const ui = uiSource()
    expect(ui).toContain("stampClosed:")
    expect(ui).toContain("stampBlocked:")
    expect(ui).toContain("repoIssueImplementBtn:")
    expect(ui).toContain("repoIssueImplementIcon:")
    expect(ui).toContain("repoIssueTitleRow:")
    expect(ui).toContain("repoIssueTitleInline:")
    // Shared parent-safe title keeps block; leaf row uses the inline token.
    expect(ui).toMatch(/repoIssueTitle:\s*\n\s*"m-0 block /)
    expect(ui).toMatch(/repoIssueImplementBtn:[\s\S]*?bg-lane-build/)
    expect(ui).toMatch(/repoIssueImplementBtn:[\s\S]*?min-h-7/)
    expect(ui).not.toContain("repoIssueImplementMenu:")
    expect(ui).toMatch(/stampClosed:[\s\S]*?border-dashed/)
    expect(ui).toMatch(/stampBlocked:[\s\S]*?bg-lane-queue/)
    // Issue #969: auto number track + baseline (not fixed 2.4rem / items-start).
    // whitespace-nowrap + tabular-nums keep short (#793) and long (#3595864)
    // GitLab iids fully readable without overlapping the title.
    const repoIssueRow = sliceBetweenMarkers(
      ui,
      "repoIssueRow:",
      "repoIssueNum:",
    )
    expect(repoIssueRow).toContain("grid-cols-[auto_minmax(0,1fr)_auto]")
    expect(repoIssueRow).toContain("items-baseline")
    expect(repoIssueRow).not.toContain("2.4rem")
    expect(repoIssueRow).not.toContain("items-start")
    const repoIssueNum = sliceBetweenMarkers(
      ui,
      "repoIssueNum:",
      "repoIssueTitleRow:",
    )
    expect(repoIssueNum).toContain("whitespace-nowrap")
    expect(repoIssueNum).toContain("tabular-nums")
    expect(repoIssueNum).toContain("shrink-0")
    // Companions no longer use the obsolete 2.4rem+gap (=2.95rem) gutter.
    const blockedBy = sliceBetweenMarkers(
      ui,
      "repoIssueBlockedBy:",
      "repoIssueBlockedByLink:",
    )
    expect(blockedBy).not.toContain("2.95rem")
    expect(blockedBy).not.toContain("pl-[")
    const repoIssueError = sliceBetweenMarkers(
      ui,
      "repoIssueError:",
      "parentIssueError:",
    )
    expect(repoIssueError).not.toContain("2.95rem")
    expect(repoIssueError).not.toContain("ml-[")
    const lifecycleInset = sliceBetweenMarkers(
      ui,
      "lifecycleInset:",
      "blankSlate:",
    )
    expect(lifecycleInset).not.toContain("2.95rem")
    expect(lifecycleInset).not.toContain("ml-[")
  })

  test("zero relevant issues retain heading chrome and explain how to add them", () => {
    const card = sliceBetweenMarkers(
      homeSource(),
      "function RepositoryCard(",
      "function RepositoryIssues(",
    )
    expect(card).toContain("const hasNoRelevantIssues =")
    expect(card).toContain("relevantIssues?.length === 0")
    expect(card).toContain("<h3 className={ui.repoIssuesKicker}>")
    expect(card).toContain("{hasNoRelevantIssues")
    expect(card).toContain('? "No relevant issues"')
    expect(card).toContain(': "Relevant issues"}')
    expect(card).toContain(
      'refreshingIssues ? "Refreshing issues" : "Refresh issues"',
    )
    expect(card).toContain("ui.repoIssuesUnrefreshed")
    // Stale projection caption (#951): guidance banner when issuesReconciledAt is old.
    expect(card).toContain("isIssueProjectionStale")
    expect(card).toContain("formatLastRefreshedAgo")
    expect(card).toContain('tag="Stale"')
    expect(card).toContain("Issues may be out of date.")

    const issues = sliceBetweenMarkers(
      homeSource(),
      "function RepositoryIssues(",
      "function ParentIssueGroup(",
    )
    expect(issues).toContain(
      "Label {forgeDisplayName(repository.forge)} issues with",
    )
    expect(issues).not.toContain("Label GitHub/GitLab issues with")
    expect(issues).toContain("ready-for-agent")
    expect(issues).toContain("for them to\n        show up here.")
    expect(issues).toContain(
      "If an issue is a child issue, the parent itself cannot be\n        a child issue too.",
    )
    expect(issues).toContain("ui.repoIssuesEmpty")

    const ui = uiSource()
    const emptyStyle = sliceBetweenMarkers(
      ui,
      "repoIssuesEmpty:",
      "repoIssuesUnrefreshed:",
    )
    // Empty guidance is one mono notch above meta chrome (issue #929).
    expect(emptyStyle).toContain("text-[0.72rem]")
    expect(emptyStyle).not.toContain("text-[0.68rem]")
    expect(emptyStyle).not.toContain("uppercase")
    // Inline ready-for-agent chip mid-aligns with surrounding sentence.
    expect(ui).toMatch(/guidanceCode:[\s\S]*?align-middle/)
    expect(ui).not.toMatch(/guidanceCode:[\s\S]*?align-baseline/)
    expect(ui).toMatch(/repoIssuesUnrefreshed:[\s\S]*?uppercase/)
  })

  test("latest work item lifecycle chrome sits in 1.5px inset panel", () => {
    const lifecycle = sliceBetweenMarkers(
      homeSource(),
      "export function WorkItemLifecycleStatus(",
      "function RepositoryIssuesSkeleton(",
    )
    expect(lifecycle).toContain('compact ? "mt-2" : ui.lifecycleInset')
    // Non-compact (repos) shows agent backend, session id + copy, worktree.
    expect(lifecycle).toContain("{workItem.agentBackend.label}")
    expect(lifecycle).toContain("ui.jobTicketRuntime")
    expect(lifecycle).toContain("sessionWorktreeParts")
    expect(lifecycle).toContain("onOpenSession")
    expect(lifecycle).toContain("<Copy value={sessionId} showValue={false}")
    expect(lifecycle).toContain("value={worktreePath}")
    // Compact kanban path keeps runtime lines outside this component.
    expect(lifecycle).toContain("{!compact ? (")
    // Earlier-lane collapse (▸ BUILD · 5m) is shared with Kanban.
    expect(lifecycle).toContain("collapseEarlierLanes")
    // COMPLETE collapses all reached lanes (including PR|MR), not only earlier.
    expect(lifecycle).toContain("collapseAllReachedLanes")
    expect(lifecycle).toContain('status === "COMPLETE"')
    expect(lifecycle).toContain('workItem.state === "COMPLETE"')
    // Mid-lifecycle step-run SUCCEEDED must not trigger collapse-all (focus strip).
    const collapseAllPredicate = sliceBetweenMarkers(
      lifecycle,
      "const collapseAllReachedLanes =",
      "const focusLane =",
    )
    expect(collapseAllPredicate).not.toContain("SUCCEEDED")
    expect(lifecycle).toContain("forgeChangeRequestShort")
    expect(lifecycle).toContain("ui.legSummary")
    // Collapsed BUILD/REVIEW/PR|MR legs share one wrap row (#784), not a
    // vertical stack — same density language as archive foot legs.
    expect(lifecycle).toContain("ui.lifecycleLegBlocks")
    expect(lifecycle).toContain("ui.legRow")
    expect(lifecycle).not.toContain("flex flex-col gap-1")

    const row = sliceBetweenMarkers(
      homeSource(),
      "function RepositoryIssueRow(",
      "export function JobsCardSkeleton(",
    )
    expect(row).toContain("onOpenSession=")
    expect(row).toContain("collapseEarlierLanes")
    expect(row).toContain("forge={repository.forge}")
    // Session Telemetry is root-route owned (#843) — no local dialog here.
    expect(row).not.toContain("<SessionUsageDialog")

    const issuesList = sliceBetweenMarkers(
      homeSource(),
      "function RepositoryIssues(",
      "function ParentIssueGroup(",
    )
    expect(issuesList).toContain("openSessionTelemetry")
    expect(issuesList).toContain("onOpenSession={onOpenSession}")
    expect(issuesList).not.toContain("<SessionUsageDialog")
    expect(issuesList).not.toContain("setSessionDialog")

    const ui = uiSource()
    expect(ui).toContain("lifecycleInset:")
    expect(ui).toMatch(/lifecycleInset:[\s\S]*?border-\[1\.5px\]/)
    expect(ui).toMatch(/lifecycleInset:[\s\S]*?border-ink/)
    // Both surfaces keep horizontal journey legs, while the lifecycle row
    // specifically top-aligns its mixed button and chip-list controls.
    expect(ui).toContain("legRow:")
    expect(ui).toContain("lifecycleLegBlocks:")
    expect(ui).toMatch(
      /lifecycleLegRowClasses\s*=\s*"flex flex-wrap items-start gap-\[0\.35rem\]"/,
    )
    expect(ui).toMatch(
      /archiveFootClasses\s*=\s*"flex flex-wrap items-center gap-\[0\.35rem\]"/,
    )
    expect(ui).toContain("archiveFoot: archiveFootClasses")
    expect(ui).toContain("legRow: lifecycleLegRowClasses")
  })

  test("running focus chips align with collapsed earlier-lane summaries", () => {
    const lifecycle = sliceBetweenMarkers(
      homeSource(),
      "export function WorkItemLifecycleStatus(",
      "function RepositoryIssuesSkeleton(",
    )
    const ui = uiSource()

    // The mixed row holds a direct button for a collapsed lane and an
    // ol/li/span for the running focus lane. The li must be a flex container:
    // otherwise its inline-flex chip participates in an inline line box and
    // acquires baseline leading above the visible chip.
    expect(lifecycle).toContain("className={ui.legRow}")
    expect(lifecycle).toContain("className={ui.legSummary}")
    expect(lifecycle).toContain('key="focus-lane"')
    expect(lifecycle).toContain("isFocusLane: true")
    const chipRenderer = sliceBetweenMarkers(
      lifecycle,
      "const renderLifecycleChip =",
      "const renderChipList =",
    )
    expect(chipRenderer).toContain(
      `key={\`\${lifecycleLabel.phase}-\${lifecycleLabel.label}\`}`,
    )
    expect(ui).toMatch(
      /lifecycleLegRowClasses\s*=\s*"flex flex-wrap items-start gap-\[0\.35rem\]"/,
    )
  })

  test("parent issue groups use an aligned details card", () => {
    const parent = sliceBetweenMarkers(
      homeSource(),
      "function ParentIssueGroup(",
      "function RepositoryIssueRow(",
    )
    expect(parent).toContain("ui.parentIssue")
    expect(parent).toContain("ui.parentIssueSummary")
    expect(parent).toContain("ui.parentIssueChildren")
    expect(parent).toContain("ui.parentIssueClosedCount")
    expect(parent).toContain("ui.repoIssueTitle")
    expect(parent).not.toContain("font-serif")
    // Implement-all failure is in-flow under the summary (not absolute on kebab).
    expect(parent).toContain("ui.parentIssueError")
    expect(parent).toContain("implementAll.isError")
    expect(parent).toContain('tone="alarm"')
    expect(parent).toContain("startWorkBannerMessage")
    expect(parent).toContain("implementAll.error")
    expect(parent).toContain("Could not start Implement all with auto-merge")
    expect(parent).toContain("errorMessage={null}")

    const ui = uiSource()
    expect(ui).toContain("parentIssue:")
    expect(ui).toMatch(/parentIssue:[\s\S]*?"group /)
    expect(ui).toContain("mx-[calc(-0.65rem-1.5px)]")
    expect(ui).toMatch(/parentIssueSummary:[\s\S]*?px-\[0\.65rem\]/)
    expect(ui).toMatch(/parentIssueChevron:[\s\S]*?group-open:rotate-180/)
    expect(ui).toContain("parentIssueChildren:")
    expect(ui).toMatch(/parentIssueChildren:[\s\S]*?px-\[0\.65rem\]/)
    expect(ui).not.toContain("before:absolute before:top-[0.35rem]")
    expect(ui).toContain("parentIssueError:")
    // Issue #969: parent summary matches leaf number/title alignment rules.
    const parentSummary = sliceBetweenMarkers(
      ui,
      "parentIssueSummary:",
      "parentIssueClosedCount:",
    )
    expect(parentSummary).toContain("grid-cols-[auto_minmax(0,1fr)_auto]")
    expect(parentSummary).toContain("items-baseline")
    expect(parentSummary).not.toContain("2.4rem")
    expect(parentSummary).not.toContain("items-start")
    expect(parent).toContain("ui.repoIssueNum")
  })

  test("repos surface locks alarm Banner weighting for leaf/refresh/remove failures", () => {
    const source = homeSource()
    // Leaf implement/queue failures.
    const leaf = sliceBetweenMarkers(
      source,
      "function RepositoryIssueRow(",
      "export function JobsCardSkeleton(",
    )
    expect(leaf).toContain("ui.bannerCompact")
    expect(leaf).toContain("ui.repoIssueError")
    expect(leaf).toContain('tone="alarm"')
    expect(leaf).toContain('tag="Error"')
    expect(leaf).toContain("startWorkBannerMessage")
    expect(leaf).toContain("queueIssue.error")
    expect(leaf).toContain("implementNow.error")
    expect(leaf).toContain("implementWith.error")
    expect(leaf).toContain("implementLocally.error")
    expect(leaf).toContain("Could not queue issue")
    expect(leaf).toContain("Could not start implementation")

    // Refresh + remove failures live on the card body (after settings dialog).
    const cardBody = sliceBetweenMarkers(
      source,
      "className={ui.repoMeta}",
      "function RepositoryIssues(",
    )
    expect(cardBody).toContain("Failed to refresh issues.")
    expect(cardBody).toContain("Could not remove repository. Please try again.")
    expect(cardBody).toContain('className={cx(ui.bannerCompact, "mb-2")}')
    expect(cardBody).toContain('className={cx(ui.bannerCompact, "mt-3")}')
    expect(cardBody).toContain('tone="alarm"')
  })

  test("blank slate and plate-primary styles exist for shared zero-repo surface", () => {
    const ui = uiSource()
    expect(ui).toContain("blankSlate:")
    expect(ui).toMatch(/blankSlate:[\s\S]*?border-2/)
    expect(ui).toMatch(/blankSlate:[\s\S]*?border-dashed/)
    expect(ui).toMatch(/blankSlate:[\s\S]*?border-ink/)
    expect(ui).toContain("blankSlateTitle:")
    expect(ui).toContain("blankSlateFieldset:")
    expect(ui).toContain("blankSlateDivider:")
    // Confirm forge identity: same-line label + control chrome (issue #771).
    expect(ui).toMatch(/blankSlateField:[\s\S]*?\bflex\b/)
    expect(ui).toMatch(/blankSlateField:[\s\S]*?items-center/)
    expect(ui).toContain("blankSlateFieldControl:")
    expect(ui).toMatch(/blankSlateFieldControl:[\s\S]*?flex-1/)
    expect(ui).toMatch(/blankSlateFieldControl:[\s\S]*?border-\[1\.5px\]/)
    expect(ui).toContain("platePrimary:")
  })

  test("every repo card carries one decorative six-lane top rail", () => {
    const source = homeSource()
    // One rail rendered per populated card, before the body panel, hidden
    // from assistive technology and carrying no focusable/heading content.
    const card = sliceBetweenMarkers(
      source,
      "function RepositoryCard(",
      "function RepositoryIssues(",
    )
    expect(card).toContain("<RepoCardRail />")
    expect(card.indexOf("<RepoCardRail />")).toBeLessThan(
      card.indexOf("<div className={ui.repoCardInner}>"),
    )
    // Rail is decorative: aria-hidden, no headings, no labels, no buttons.
    const rail = sliceBetweenMarkers(
      source,
      "function RepoCardRail() {",
      "function RepositoryCard(",
    )
    expect(rail).toContain('aria-hidden="true"')
    expect(rail).toContain("PIPELINE_LANES.map")
    expect(rail).toContain("style={{ backgroundColor: lane.color }}")
    expect(rail).not.toContain("<h1")
    expect(rail).not.toContain("<h2")
    expect(rail).not.toContain("<button")
    expect(rail).not.toContain("aria-label")

    const ui = uiSource()
    expect(ui).toContain("repoCardRail:")
    expect(ui).toContain("repoCardRailSegment:")
    expect(ui).toMatch(/repoCardRail:[\s\S]*?flex/)
    expect(ui).toMatch(/repoCardRailSegment:[\s\S]*?flex-1/)
    // Casing is #252827, distinct from Merged's #151515 fill, so the final
    // segment stays visible (Pipeline's complete-sheet contrast).
    expect(ui).toMatch(/repoCardRail:[\s\S]*?bg-\[#252827\]/)
    // Segments are equal-width; lane fill is external (PIPELINE_LANES), so the
    // recipe must not hard-code a lane color.
    const segment = sliceBetweenMarkers(
      ui,
      "repoCardRailSegment: cx(",
      "repoCardRailRivet",
    )
    expect(segment).not.toContain("bg-lane-")
    expect(segment).not.toContain("backgroundColor")
  })

  test("repo card skeleton mirrors the forged frame and rail geometry", () => {
    const source = homeSource()
    // RepositoryCardsSkeleton is the last declaration in the file.
    const skeleton = source.slice(
      source.indexOf("export function RepositoryCardsSkeleton("),
    )
    expect(skeleton).toContain("ui.repoCardSkeleton")
    expect(skeleton).toContain("<RepoCardRail />")
    expect(skeleton).toContain("ui.repoCardSkeletonInner")

    const ui = uiSource()
    expect(ui).toContain("repoCardSkeleton:")
    expect(ui).toMatch(/repoCardSkeleton:[\s\S]*?repoCardFrameShell/)
    expect(ui).toMatch(/repoCardSkeleton:[\s\S]*?repoCardFrameCasing/)
    expect(ui).toContain("repoCardSkeletonInner:")
    expect(ui).toMatch(/repoCardSkeletonInner:[\s\S]*?bg-panel/)
  })
})
