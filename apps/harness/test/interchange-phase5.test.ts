import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

const copySource = () =>
  readFileSync(join(import.meta.dir, "../src/copy.tsx"), "utf8")

const outcomeSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/work-item-outcome-presentation.tsx"),
    "utf8",
  )

const kanbanDoc = () =>
  readFileSync(join(import.meta.dir, "../../../docs/kanban.md"), "utf8")

const sliceBetween = (source: string, start: string, end: string): string => {
  const s = source.indexOf(start)
  if (s < 0) throw new Error(`Start not found: ${start}`)
  const e = source.indexOf(end, s)
  if (e < 0) throw new Error(`End not found after ${start}: ${end}`)
  return source.slice(s, e)
}

/**
 * Interchange phase 5 — dialogs, menus, chrome + Ledger teardown (#704).
 */
describe("Interchange phase 5: dialogs, menus, chrome + Ledger teardown", () => {
  test("settings dialog uses shared Interchange shell (panel, kicker, plates)", () => {
    const root = rootSource()
    const dialog = sliceBetween(root, "<dialog", "</dialog>")
    expect(dialog).toContain('className="dialog-panel"')
    expect(dialog).toContain("dialog-header")
    expect(dialog).toContain("dialog-kicker")
    expect(dialog).toContain("dialog-title")
    expect(dialog).toContain("dialog-lede")
    expect(dialog).toContain("dialog-body")
    expect(dialog).toContain("dialog-footer")
    expect(dialog).toContain("dialog-field")
    expect(dialog).toContain("dialog-status-row")
    expect(dialog).toContain('className="plate-mini"')
    expect(dialog).toContain('className="plate-primary"')
    expect(dialog).toContain("Save settings")
    expect(dialog).toContain("Cancel")
    // Compact banners replace oxblood wash callouts.
    expect(dialog).toContain("banner--compact")
    expect(dialog).not.toContain("font-serif")
    expect(dialog).not.toContain("oxblood")
    expect(dialog).not.toContain("shadow-[")
    expect(dialog).not.toContain("backdrop:bg-")
  })

  test("repository settings dialog matches the same shell contract", () => {
    const home = homeSource()
    const dialog = sliceBetween(home, "ref={settingsDialogRef}", "</dialog>")
    expect(dialog).toContain('className="dialog-panel"')
    expect(dialog).toContain("dialog-header")
    expect(dialog).toContain("dialog-kicker")
    expect(dialog).toContain("dialog-title")
    expect(dialog).toContain("dialog-fieldset")
    expect(dialog).toContain("dialog-check")
    expect(dialog).toContain("dialog-input")
    expect(dialog).toContain('className="plate-primary"')
    expect(dialog).toContain('className="plate-mini"')
    expect(dialog).not.toContain("font-serif")
    expect(dialog).not.toContain("oxblood")
    expect(dialog).not.toContain("shadow-[")
    const styles = stylesSource()
    expect(styles).toContain('.dialog-check input[type="checkbox"]')
    expect(styles).toContain("accent-color: var(--signal)")
  })

  test("session usage dialog is narrow shell with table and telemetry banners", () => {
    const home = homeSource()
    const dialog = sliceBetween(
      home,
      "export function SessionUsageDialog",
      "export function JobsCardSkeleton",
    )
    expect(dialog).toContain("dialog-panel dialog-panel--narrow")
    expect(dialog).toContain("dialog-kicker")
    expect(dialog).toContain("dialog-title")
    expect(dialog).toContain("dialog-table")
    expect(dialog).toContain("banner--compact")
    expect(dialog).toContain('tag="Session"')
    expect(dialog).toContain('className="plate-mini"')
    expect(dialog).not.toContain("font-serif")
    expect(dialog).not.toContain("oxblood")
    expect(dialog).not.toContain("shadow-[")
  })

  test("menus use flush menu-panel (no drop shadow) and destructive Attention hover/focus", () => {
    const home = homeSource()
    const styles = stylesSource()
    expect(home).toContain('className="menu-panel min-w-40"')
    expect(home).toContain("menu-item menu-item--destructive")
    expect(home).toContain('className="menu-sep"')
    expect(styles).toContain(".menu-panel")
    expect(styles).toContain("box-shadow: none")
    expect(styles).toContain(
      ".menu-item--destructive:is(:hover, :focus-visible)",
    )
    expect(styles).toMatch(
      /\.menu-item--destructive:is\(:hover, :focus-visible\)\s*\{[^}]*background:\s*var\(--lane-attention\)/s,
    )
    expect(home).not.toContain("shadow-[")
  })

  test("chrome: skeletons use line-ghost bars; copy keeps PR-green success glyph", () => {
    const home = homeSource()
    const styles = stylesSource()
    const copy = copySource()
    const completed = readFileSync(
      join(import.meta.dir, "../src/routes/completed.tsx"),
      "utf8",
    )
    expect(home).toContain('className="skeleton')
    expect(completed).toContain('className="skeleton h-14"')
    expect(home).toContain('className="merged-pr-stats-skeleton"')
    expect(home).not.toContain("merged-pr-stats-skeleton animate-pulse")
    expect(styles).toContain(".skeleton")
    expect(styles).toContain("background: var(--line-ghost)")
    expect(styles).toMatch(
      /\.merged-pr-stats-skeleton\s*\{[^}]*animation:\s*skeleton-pulse/s,
    )
    expect(copy).toContain("icon-btn--copied")
    expect(copy).toContain("1_500")
    expect(styles).toContain(".icon-btn--copied")
    expect(styles).toMatch(
      /\.icon-btn--copied\s*\{[^}]*color:\s*var\(--lane-pr\)/s,
    )
  })

  test("dialog fields keep focus-visible outline; primary plate wait only when busy", () => {
    const styles = stylesSource()
    expect(styles).not.toMatch(/\.dialog-input\s*\{[^}]*outline:\s*none/s)
    expect(styles).toContain(".dialog-field > select:focus-visible")
    expect(styles).toContain("outline: 2px solid var(--ink)")
    expect(styles).toContain('.plate-primary:disabled[aria-busy="true"]')
    expect(styles).toMatch(
      /\.plate-primary:disabled\s*\{[^}]*cursor:\s*not-allowed/s,
    )
    const root = rootSource()
    const home = homeSource()
    expect(root).toContain("aria-busy={updateConfig.isPending || undefined}")
    expect(home).toContain("aria-busy={updateSettings.isPending || undefined}")
    expect(home).toContain("dialog-title dialog-title--path")
  })

  test("Ledger teardown: no serif/oxblood/washes/field-rule; stamps stay Interchange", () => {
    const styles = stylesSource()
    const root = rootSource()
    const home = homeSource()
    const outcome = outcomeSource()
    const completed = readFileSync(
      join(import.meta.dir, "../src/routes/completed.tsx"),
      "utf8",
    )
    const parentMenu = readFileSync(
      join(import.meta.dir, "../src/parent-issue-actions-menu.tsx"),
      "utf8",
    )
    const all = `${styles}\n${root}\n${home}\n${outcome}\n${completed}\n${parentMenu}`

    expect(all).not.toContain("font-serif")
    expect(all).not.toContain("oxblood")
    expect(all).not.toContain("field-rule")
    expect(all).not.toContain("entry-rule")
    expect(all).not.toContain("--color-sepia")
    expect(all).not.toContain("--color-olive")
    expect(all).not.toContain("--color-teal")
    expect(all).not.toContain("--font-serif")
    expect(all).not.toContain("--paper-2")
    expect(all).not.toContain("shadow-[")
    // Interchange exception stamps remain (§5.6).
    expect(styles).toContain(".stamp--closed")
    expect(styles).toContain(".stamp--blocked")
    expect(outcome).toContain("completion-summary")
  })

  test("kanban.md points at harness-design-system.md", () => {
    const doc = kanbanDoc()
    expect(doc).toContain("docs/harness-design-system.md")
    expect(doc).toContain("Interchange")
  })
})
