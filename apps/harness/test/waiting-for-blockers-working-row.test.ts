import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const chromeSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/work-item-progress-chrome.ts"),
    "utf8",
  )

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

describe("Waiting for blockers Working-row polish", () => {
  test("badge chrome uses Interchange hold tags for blockers and worker slot", () => {
    // Spec §5.1: both holds share dashed status-tag--hold; distinction is the label.
    const chrome = chromeSource()
    expect(chrome).toContain('status === "WAITING_FOR_WORKER_SLOT"')
    expect(chrome).toContain('status === "WAITING_FOR_BLOCKERS"')
    expect(chrome).toContain("status-tag--hold")
    expect(chrome).toContain("status-tag--plain")
    expect(chrome).toContain("status-tag--alarm")
    expect(stylesSource()).toContain(".status-tag--hold")
    expect(stylesSource()).toContain("border-style: dashed")
  })

  test("status message uses shared helper with alarm prefix for failures", () => {
    const source = homeSource()
    expect(source).toContain("statusMessageClassNameForStatus")
    expect(source).toContain("statusMessageClassName")
    expect(chromeSource()).toContain(
      "export function statusMessageClassNameForStatus",
    )
    expect(chromeSource()).toContain("status-message--alarm")
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
    expect(lifecycle).toContain("resetWorkItem")
    expect(lifecycle).toContain(
      'aria-label={reset.isPending ? "Resetting job" : "Reset job"}',
    )
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
