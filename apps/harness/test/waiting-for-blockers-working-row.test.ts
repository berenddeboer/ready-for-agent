import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const chromeSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/work-item-progress-chrome.ts"),
    "utf8",
  )

const uiSource = () =>
  readFileSync(join(import.meta.dir, "../src/ui.ts"), "utf8")

describe("Waiting for blockers Working-row polish", () => {
  test("badge chrome uses Interchange hold tags for blockers and worker slot", () => {
    // Spec §5.1: both holds share dashed status-tag--hold; distinction is the label.
    const chrome = chromeSource()
    expect(chrome).toContain('status === "WAITING_FOR_WORKER_SLOT"')
    expect(chrome).toContain('status === "WAITING_FOR_BLOCKERS"')
    expect(chrome).toContain("ui.statusTagHold")
    expect(chrome).toContain("ui.statusTagPlain")
    expect(chrome).toContain("ui.statusTagAlarm")
    const ui = uiSource()
    expect(ui).toContain("statusTagHold:")
    expect(ui).toMatch(/statusTagHold:[\s\S]*?border-dashed/)
  })

  test("status message uses shared helper with alarm prefix for failures", () => {
    const source = homeSource()
    expect(source).toContain("statusMessageClassNameForStatus")
    expect(source).toContain("statusMessageClassName")
    expect(source).toContain("isStatusMessageAlarm")
    expect(source).not.toContain("status-message--alarm")
    expect(chromeSource()).toContain(
      "export function statusMessageClassNameForStatus",
    )
    expect(chromeSource()).toContain("export function isStatusMessageAlarm")
    expect(chromeSource()).toContain("ui.statusMessageAlarm")
  })

  test("Pause/Start control is omitted while Waiting for blockers", () => {
    const source = homeSource()
    const pauseFnStart = source.indexOf("function WorkItemPauseButton(")
    expect(pauseFnStart).toBeGreaterThan(-1)
    const pauseFnEnd = source.indexOf(
      "function WorkItemLifecycleStatus(",
      pauseFnStart,
    )
    const pauseFn = source.slice(pauseFnStart, pauseFnEnd)
    expect(pauseFn).toContain(
      'workItem.isTerminal || workItem.status === "WAITING_FOR_BLOCKERS"',
    )
    expect(pauseFn).toContain("return null")
  })

  test("held Working row offers Reset and withholds Retry", () => {
    const source = homeSource()
    const lifecycleStart = source.indexOf("function WorkItemLifecycleStatus(")
    expect(lifecycleStart).toBeGreaterThan(-1)
    const lifecycle = source.slice(lifecycleStart)
    expect(lifecycle).toContain(
      'const heldForBlockers = status === "WAITING_FOR_BLOCKERS"',
    )
    expect(lifecycle).toContain(
      "const canRetry = compact && workItem.canRetry && !heldForBlockers",
    )
    expect(lifecycle).toContain("canShowWorkItemResetAction({")
    expect(lifecycle).toContain("isTerminal: workItem.isTerminal")
    expect(lifecycle).toContain('isNeedsHuman: status === "NEEDS_HUMAN"')
    expect(lifecycle).toContain('isFailed: status === "FAILED"')
    expect(lifecycle).toContain("resetWorkItem")
    expect(lifecycle).toContain("<WorkItemResetButton")
    expect(lifecycle).toContain("pending={reset.isPending}")
    expect(lifecycle).toContain("onReset={() => reset.mutate()}")
  })

  test("Issue kebab offers Queue and Implement actions from shared eligibility", () => {
    const source = homeSource()
    expect(source).toContain("issueActionEligibility({")
    expect(source).toContain('queueIssue.isPending ? "Queueing..." : "Queue"')
    expect(source).toContain("{canImplement && (")
    expect(source).toContain("{canQueue && (")
    expect(source).toContain("Implement now")
    expect(source).toContain("Implement locally")
  })
})
