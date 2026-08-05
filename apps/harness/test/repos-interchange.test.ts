import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

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
  test("repo cards use 1.5px ticket shell, display title, mono PR count, icon controls", () => {
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
    expect(ui).toMatch(/repoCard:[\s\S]*?border-\[1\.5px\]/)
    expect(ui).toMatch(/repoCard:[\s\S]*?border-ink/)
    expect(ui).toContain("repoCardTitle:")
    expect(ui).toMatch(/repoCardTitle:[\s\S]*?text-\[1\.06rem\]/)
    expect(ui).toMatch(/repoCardLink:[\s\S]*?hover:decoration-signal/)
  })

  test("meta table is hairline two-column mono dt/dd with harness-default annotations", () => {
    const body = sliceBetweenMarkers(
      homeSource(),
      "className={ui.repoMeta}",
      "function RepositoryIssues(",
    )
    expect(body).toContain("ui.repoMetaRow")
    expect(body).toContain("Harness default (")
    expect(body).toContain("<dt>Path</dt>")
    expect(body).toContain("<dt>Agent Backend</dt>")

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
      "export function SessionUsageDialog(",
    )
    expect(issues).toContain("ui.repoIssue")
    expect(issues).toContain("ui.repoIssueNum")
    expect(issues).toContain("ui.repoIssueTitle")
    expect(issues).toContain("ui.repoIssueAuthor")
    expect(issues).toContain("ui.stamp")
    expect(issues).toContain("ui.stampClosed")
    expect(issues).toContain("Closed")
    expect(issues).toContain("ui.stampBlocked")
    expect(issues).toContain("Blocked")
    expect(issues).toContain("ui.repoIssueBlockedBy")
    expect(issues).toContain("Blocked by")
    // Old amber row-wash language is dropped.
    expect(issues).not.toContain("bg-amber-wash")
    expect(issues).not.toContain("border-sepia")
    expect(issues).not.toContain("text-sepia")
    expect(issues).not.toContain("font-serif")

    const ui = uiSource()
    expect(ui).toContain("stampClosed:")
    expect(ui).toContain("stampBlocked:")
    expect(ui).toMatch(/stampClosed:[\s\S]*?border-dashed/)
    expect(ui).toMatch(/stampBlocked:[\s\S]*?bg-lane-queue/)
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
      "export function SessionUsageDialog(",
    )
    expect(row).toContain("onOpenSession=")
    expect(row).toContain("collapseEarlierLanes")
    expect(row).toContain("forge={repository.forge}")
    // One SessionUsageDialog at RepositoryIssues — not per issue row.
    expect(row).not.toContain("<SessionUsageDialog")

    const issuesList = sliceBetweenMarkers(
      homeSource(),
      "function RepositoryIssues(",
      "function ParentIssueGroup(",
    )
    expect(issuesList).toContain("<SessionUsageDialog")
    expect(issuesList).toContain("onOpenSession={onOpenSession}")

    const ui = uiSource()
    expect(ui).toContain("lifecycleInset:")
    expect(ui).toMatch(/lifecycleInset:[\s\S]*?border-\[1\.5px\]/)
    expect(ui).toMatch(/lifecycleInset:[\s\S]*?border-ink/)
    // Shared horizontal leg-row recipe (lifecycle chrome + archive foot).
    expect(ui).toContain("legRow:")
    expect(ui).toContain("lifecycleLegBlocks:")
    expect(ui).toMatch(
      /legRowClasses\s*=\s*"flex flex-wrap items-center gap-\[0\.35rem\]"/,
    )
    expect(ui).toContain("archiveFoot: legRowClasses")
    expect(ui).toContain("legRow: legRowClasses")
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
  })

  test("repos surface locks alarm Banner weighting for leaf/refresh/remove failures", () => {
    const source = homeSource()
    // Leaf implement/queue failures.
    const leaf = sliceBetweenMarkers(
      source,
      "function RepositoryIssueRow(",
      "export function SessionUsageDialog(",
    )
    expect(leaf).toContain("ui.bannerCompact")
    expect(leaf).toContain("ui.repoIssueError")
    expect(leaf).toContain('tone="alarm"')
    expect(leaf).toContain('tag="Error"')
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
    expect(ui).toContain("platePrimary:")
  })
})
