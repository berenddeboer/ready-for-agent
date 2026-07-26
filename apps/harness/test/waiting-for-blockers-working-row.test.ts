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
  test("badge chrome uses teal for blockers, violet for worker slot, oxblood for Queued", () => {
    const chrome = chromeSource()
    expect(chrome).toContain('status === "WAITING_FOR_WORKER_SLOT"')
    expect(chrome).toContain('status === "WAITING_FOR_BLOCKERS"')
    expect(chrome).toContain("bg-teal-wash text-teal")
    expect(chrome).toContain("bg-violet-wash text-violet-800")
    expect(chrome).toContain("bg-oxblood-wash text-oxblood")
    // Shared violet for both wait holds must not remain.
    expect(chrome).not.toMatch(
      /WAITING_FOR_WORKER_SLOT\s*\|\|\s*\n?\s*status === "WAITING_FOR_BLOCKERS"/,
    )
    expect(stylesSource()).toContain("--color-teal:")
    expect(stylesSource()).toContain("--color-teal-wash:")
  })

  test("status message uses distinct wait-hold tones via shared helper", () => {
    const source = homeSource()
    expect(source).toContain("statusMessageClassNameForStatus")
    expect(source).toContain("statusMessageClassName")
    expect(chromeSource()).toContain(
      "export function statusMessageClassNameForStatus",
    )
    expect(chromeSource()).toContain(
      'if (status === "WAITING_FOR_BLOCKERS") return "text-teal"',
    )
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
    expect(lifecycle).toContain("const canReset = compact")
    expect(lifecycle).toContain("resetWorkItem")
    expect(lifecycle).toContain(
      'aria-label={reset.isPending ? "Resetting job" : "Reset job"}',
    )
  })

  test("blocked Issue kebab offers Queue only; Actionable keeps Implement", () => {
    const source = homeSource()
    expect(source).toContain("const isQueueable =")
    expect(source).toContain("const canQueue =")
    expect(source).toContain(
      'issue.state === "OPEN" && !issue.hasChildren && issue.blockedBy.length > 0',
    )
    expect(source).toContain(
      'issue.state === "OPEN" && !issue.hasChildren && issue.blockedBy.length === 0',
    )
    expect(source).toContain('queueIssue.isPending ? "Queueing..." : "Queue"')
    expect(source).toContain("{canImplement && (")
    expect(source).toContain("{canQueue && (")
    expect(source).toContain("Implement now")
    expect(source).toContain("Implement locally")
  })
})
