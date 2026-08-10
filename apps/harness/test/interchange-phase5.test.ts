import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const uiSource = () =>
  readFileSync(join(import.meta.dir, "../src/ui.ts"), "utf8")

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
    expect(dialog).toContain("ui.dialogPanel")
    expect(dialog).toContain("ui.dialogHeader")
    expect(dialog).toContain("ui.dialogKicker")
    expect(dialog).toContain("ui.dialogTitle")
    expect(dialog).toContain("ui.dialogLede")
    expect(dialog).toContain("ui.dialogBodySectioned")
    expect(dialog).toContain("ui.dialogSection")
    expect(dialog).toContain("ui.dialogSectionHead")
    expect(dialog).toContain("ui.dialogSectionTitle")
    expect(dialog).toContain("ui.dialogFooter")
    expect(dialog).toContain("ui.dialogField")
    expect(dialog).toContain("ui.dialogInput")
    expect(dialog).toContain("ui.dialogStatusRow")
    expect(dialog).toContain("ui.plateMini")
    expect(dialog).toContain("ui.platePrimary")
    expect(dialog).toContain("Save settings")
    expect(dialog).toContain("Cancel")
    // Prototype D section cards
    expect(dialog).toContain("Agent backend")
    expect(dialog).toContain("Models")
    expect(dialog).toContain("Concurrency")
    // Compact banners replace oxblood wash callouts.
    expect(dialog).toContain("ui.bannerCompact")
    expect(dialog).not.toContain("font-serif")
    expect(dialog).not.toContain("oxblood")
    // No raw shadow utilities on the dialog markup (recipe owns shadow-none).
    expect(dialog).not.toContain("shadow-[")
    expect(dialog).not.toContain("backdrop:bg-")
  })

  test("repository settings dialog matches the same shell contract", () => {
    const home = homeSource()
    const dialog = sliceBetween(home, "ref={settingsDialogRef}", "</dialog>")
    expect(dialog).toContain("ui.dialogPanel")
    expect(dialog).toContain("ui.dialogHeader")
    expect(dialog).toContain("ui.dialogKicker")
    expect(dialog).toContain("ui.dialogTitle")
    expect(dialog).toContain("ui.dialogBodySectioned")
    expect(dialog).toContain("ui.dialogSection")
    expect(dialog).toContain("ui.dialogSectionHead")
    expect(dialog).toContain("ui.dialogCheck")
    expect(dialog).toContain("ui.dialogInput")
    expect(dialog).toContain("ui.platePrimary")
    expect(dialog).toContain("ui.plateMini")
    // Issue #771: Forge identity fields use label-then-colon presentation.
    expect(dialog).toContain("Forge identity")
    expect(dialog).toContain("Forge:")
    expect(dialog).toContain("Forge host:")
    expect(dialog).toContain("Project path:")
    expect(dialog).toContain("Agent backend")
    expect(dialog).toContain("Models")
    expect(dialog).toContain("Options")
    expect(dialog).toContain("ui.dialogCheckInput")
    expect(dialog).toContain("ui.dialogCheckHint")
    expect(dialog).not.toContain("font-serif")
    expect(dialog).not.toContain("oxblood")
    expect(dialog).not.toContain("shadow-[")
    const ui = uiSource()
    expect(ui).toContain("dialogCheck:")
    expect(ui).toContain("dialogCheckInput:")
    expect(ui).toMatch(/dialogCheckInput:[\s\S]*?accent-signal/)
    expect(ui).toContain("dialogBodySectioned:")
    expect(ui).toMatch(/dialogBodySectioned:[\s\S]*?bg-dialog-stage/)
    expect(ui).toContain("dialogSection:")
    expect(ui).toMatch(/dialogInput:[\s\S]*?--plate/)
    expect(ui).toMatch(/dialogFieldHint:[\s\S]*?text-ink-2/)
    const styles = stylesSource()
    expect(styles).toContain("--dialog-stage:")
    expect(styles).toContain("--color-dialog-stage:")
  })

  test("session usage dialog is narrow shell with table and telemetry banners", () => {
    const dialog = readFileSync(
      join(import.meta.dir, "../src/session-usage-dialog.tsx"),
      "utf8",
    )
    expect(dialog).toContain("ui.dialogPanel")
    expect(dialog).toContain("ui.dialogPanelNarrow")
    expect(dialog).toContain("ui.dialogKicker")
    expect(dialog).toContain("ui.dialogTitle")
    expect(dialog).toContain("ui.dialogTable")
    expect(dialog).toContain("ui.bannerCompact")
    expect(dialog).toContain('tag="Session"')
    expect(dialog).toContain("ui.plateMini")
    expect(dialog).not.toContain("font-serif")
    expect(dialog).not.toContain("oxblood")
    expect(dialog).not.toContain("shadow-[")
  })

  test("menus use flush menu-panel (no drop shadow) and destructive Attention hover/focus", () => {
    const home = homeSource()
    const ui = uiSource()
    expect(home).toContain('className={cx(ui.menuPanel, "min-w-40")}')
    expect(home).toContain("ui.menuItem, ui.menuItemDestructive")
    expect(home).toContain("ui.menuSep")
    expect(ui).toContain("menuPanel:")
    expect(ui).toMatch(/menuPanel:[\s\S]*?shadow-none/)
    expect(ui).toContain("menuItemDestructive:")
    expect(ui).toMatch(/menuItemDestructive:[\s\S]*?hover:bg-lane-attention/)
    expect(ui).toMatch(
      /menuItemDestructive:[\s\S]*?focus-visible:bg-lane-attention/,
    )
    // Component source must not reintroduce raw drop shadows.
    expect(home).not.toContain("shadow-[")
  })

  test("chrome: skeletons use line-ghost bars; copy keeps PR-green success glyph", () => {
    const home = homeSource()
    const ui = uiSource()
    const styles = stylesSource()
    const copy = copySource()
    const dashboard = readFileSync(
      join(import.meta.dir, "../src/committed-pr-dashboard.tsx"),
      "utf8",
    )
    expect(home).toContain("ui.skeleton")
    expect(dashboard).toContain("ui.mergedPrStatsSkeleton")
    expect(dashboard).not.toContain("merged-pr-stats-skeleton animate-pulse")
    expect(ui).toContain("skeleton:")
    expect(ui).toMatch(/skeleton:[\s\S]*?bg-line-ghost/)
    expect(ui).toMatch(/mergedPrStatsSkeleton:[\s\S]*?animate-\[skeleton-pulse/)
    // Keyframes stay in the tokens stylesheet.
    expect(styles).toContain("@keyframes skeleton-pulse")
    expect(copy).toContain("ui.iconBtnBare")
    expect(copy).toContain("ui.iconBtnCopied")
    expect(copy).toContain("1_500")
    expect(ui).toContain("iconBtnBare:")
    expect(ui).toMatch(/iconBtnBare:[\s\S]*?border-0/)
    expect(ui).toContain("iconBtnCopied:")
    expect(ui).toMatch(/iconBtnCopied:[\s\S]*?text-lane-pr/)
  })

  test("dialog fields keep focus-visible outline; primary plate wait only when busy", () => {
    const ui = uiSource()
    // Default dialog input must not force outline-none; focus-visible ring stays.
    expect(ui).not.toMatch(/dialogInput:[\s\S]*?outline-none/)
    expect(ui).toMatch(/dialogInput:[\s\S]*?focus-visible:outline/)
    expect(ui).toMatch(/dialogInput:[\s\S]*?focus-visible:outline-ink/)
    // Primary is riveted plate twin of mini (not solid-ink fill).
    // Slice each recipe so later recipes with bottom bevels don't false-match.
    const platePrimaryBlock = ui.slice(
      ui.indexOf("platePrimary:"),
      ui.indexOf("plateReady:"),
    )
    const plateMiniBlock = ui.slice(
      ui.indexOf("plateMini:"),
      ui.indexOf("bannerCompact:"),
    )
    expect(platePrimaryBlock).toContain("--plate")
    expect(platePrimaryBlock).toContain("plateMiniRivets")
    expect(platePrimaryBlock).toContain("inset_0_1px_0_var(--plate-hi)")
    expect(platePrimaryBlock).not.toContain("inset_0_-2px")
    expect(plateMiniBlock).toContain("inset_0_1px_0_var(--plate-hi)")
    expect(plateMiniBlock).not.toContain("inset_0_-2px")
    expect(ui).toMatch(/platePrimary:[\s\S]*?disabled:aria-busy:cursor-wait/)
    expect(ui).toMatch(/platePrimary:[\s\S]*?disabled:cursor-not-allowed/)
    // Ready plate: PR-green fill + light text; same rivets/bevel/disabled chrome.
    // Slice to the next section so later stamps/lanes do not false-match.
    const plateReadyBlock = ui.slice(
      ui.indexOf("plateReady:"),
      ui.indexOf("/* ---------- Stamps"),
    )
    expect(plateReadyBlock).toContain("bg-lane-pr")
    expect(plateReadyBlock).toContain("text-white")
    expect(plateReadyBlock).toContain("plateMiniRivets")
    expect(plateReadyBlock).toContain("inset_0_1px_0_var(--plate-hi)")
    expect(plateReadyBlock).not.toContain("inset_0_-2px")
    expect(plateReadyBlock).toContain("hover:brightness-110")
    expect(plateReadyBlock).toContain("disabled:opacity-55")
    expect(plateReadyBlock).toContain("disabled:aria-busy:cursor-wait")
    const root = rootSource()
    const home = homeSource()
    expect(root).toContain("aria-busy={updateConfig.isPending || undefined}")
    expect(home).toContain("aria-busy={updateSettings.isPending || undefined}")
    expect(home).toContain("ui.dialogTitlePath")
  })

  test("Ledger teardown: no serif/oxblood/washes/field-rule; stamps stay Interchange", () => {
    const styles = stylesSource()
    const ui = uiSource()
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
    // Component sources (not ui recipes — those legitimately use shadow-[inset…]).
    const components = `${styles}\n${root}\n${home}\n${outcome}\n${completed}\n${parentMenu}`

    expect(components).not.toContain("font-serif")
    expect(components).not.toContain("oxblood")
    expect(components).not.toContain("field-rule")
    expect(components).not.toContain("entry-rule")
    expect(components).not.toContain("--color-sepia")
    expect(components).not.toContain("--color-olive")
    expect(components).not.toContain("--color-teal")
    expect(components).not.toContain("--font-serif")
    expect(components).not.toContain("--paper-2")
    // Component markup must not reintroduce raw shadow utilities.
    expect(components).not.toContain("shadow-[")
    // Interchange exception stamps remain as recipes (§5.6).
    expect(ui).toContain("stampClosed:")
    expect(ui).toContain("stampBlocked:")
    expect(outcome).toContain("ui.completionSummary")
  })

  test("kanban.md points at harness-design-system.md", () => {
    const doc = kanbanDoc()
    expect(doc).toContain("docs/harness-design-system.md")
    expect(doc).toContain("Interchange")
  })
})
