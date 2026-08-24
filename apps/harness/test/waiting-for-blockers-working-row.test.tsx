import { readFileSync } from "node:fs"
import { join } from "node:path"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { type WorkItem, WorkItemPauseButton } from "../src/home-page-content.js"
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

const runningWorkItem = {
  id: "wi-01J00000000000000000000000",
  repositoryId: "repo-1",
  issueNumber: 26,
  issueTitle: "Pause a running Work Item",
  pullRequestNumber: null,
  agentBackend: { id: "opencode", label: "OpenCode" },
  state: "IMPLEMENT",
  stateLabel: "Build",
  status: "RUNNING",
  statusLabel: "Running",
  statusMessage: null,
  latestStepRunDetail: null,
  postponedUntil: null,
  paused: false,
  hasActiveStepRun: true,
  canRetry: false,
  isTerminal: false,
  failureCode: null,
  sessionId: null,
  worktreePath: "/tmp/worktree",
  completionSummary: null,
  createdAt: "2026-08-07T11:00:00.000Z",
  stateReadyAt: "2026-08-07T11:00:00.000Z",
  lifecycleLabels: [],
} satisfies WorkItem

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
    expect(pauseFn).toContain("workItemPauseControl({")
    expect(pauseFn).toContain('control.kind === "hidden"')
    expect(pauseFn).toContain("return null")
    expect(pauseFn).toContain("interruptWorkItem")
  })

  test("Pause control warns that pausing does not stop a running Step Run", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <WorkItemPauseButton workItem={runningWorkItem} />
      </QueryClientProvider>,
    )

    expect(html).toContain('aria-label="Pause job"')
    expect(html).toContain(
      'title="Pause job — does not stop the running Step Run. Interrupt after pausing before editing the worktree."',
    )
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

  test("Issue row keeps direct Implement and restores the complete kebab", () => {
    const source = homeSource()
    expect(source).toContain("issueActionEligibility({")
    expect(source).toContain("{canImplement && (")
    expect(source).toContain("<IssueActionsMenu")
    // Primary blue cue after the title for implementable issues only.
    expect(source).toContain("ui.repoIssueImplementBtn")
    expect(source).toContain("ui.repoIssueImplementIcon")
    expect(source).toContain("ui.repoIssueTitleRow")
    expect(source).toContain("ui.repoIssueTitleInline")
    expect(source).toContain("Implement issue #")
    expect(source).toContain("queueIssue.reset()")
    expect(source).toContain("implementNow.mutate()")
    expect(source).toContain("onClick={startImplementNow}")
    // The rightmost kebab retains Implement now, Implement with..., locally.
    expect(source).toContain("<IssueActionsMenu")
    expect(source).toContain("onImplementWith={startImplementWith}")
    expect(source).toContain("implementLocally.mutate()")
    expect(source).toContain("setImplementWithOpen(true)")
    expect(source).toMatch(
      /implementNow\.isPending \|\|\s*implementWith\.isPending \|\|\s*implementLocally\.isPending \|\|\s*queueIssue\.isPending/,
    )
    expect(source).toContain("implementLocally.isError")
    // Pending disables the primary cue (styles + behavior stay aligned).
    expect(source).toContain("disabled={implementPending}")
    expect(source).toContain('implementPending ? "Starting..." : "Implement"')
    // No prominent Queue cue — blocked Queue remains under kebab only.
    expect(source).not.toContain('"Queue >"')
    expect(source).not.toContain('"Implement >"')
    expect(source).toContain("className={ui.iconBtn}")
  })
})
