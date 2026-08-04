import { cx, ui } from "../src/ui.js"
import {
  isStatusMessageAlarm,
  kanbanPullRequestBadgePlacement,
  lifecycleStepChipClassName,
  lifecycleStepChipClassNameForStatus,
  prBadgeClassName,
  statusBadgeBaseClassName,
  statusBadgeClassNameForStatus,
  statusMessageClassNameForStatus,
} from "../src/work-item-progress-chrome.js"
import { describe, expect, test } from "bun:test"

describe("work-item-progress-chrome", () => {
  test("lifecycle step chips use Interchange leg classes (no radius)", () => {
    expect(lifecycleStepChipClassName).toBe(cx(ui.leg, ui.legDone))
    expect(lifecycleStepChipClassName).not.toContain("rounded")
    expect(lifecycleStepChipClassNameForStatus("SUCCEEDED")).toBe(
      cx(ui.leg, ui.legDone),
    )
    expect(lifecycleStepChipClassNameForStatus("RUNNING")).toBe(
      cx(ui.leg, ui.legRun),
    )
    expect(lifecycleStepChipClassNameForStatus("QUEUED")).toBe(
      cx(ui.leg, ui.legNext),
    )
    expect(lifecycleStepChipClassNameForStatus("FAILED")).toBe(
      cx(ui.leg, ui.legFail),
    )
    // Needs-human shares Attention fill with failures — not lane-colored "run".
    expect(lifecycleStepChipClassNameForStatus("NEEDS_HUMAN")).toBe(
      cx(ui.leg, ui.legFail),
    )
    expect(lifecycleStepChipClassNameForStatus("NEEDS_HUMAN_REVIEW")).toBe(
      cx(ui.leg, ui.legFail),
    )
  })

  test("status tags and PR badge use Interchange ui recipes", () => {
    expect(statusBadgeBaseClassName).toBe(ui.statusTag)
    expect(prBadgeClassName).toBe(ui.prBadge)
    expect(statusBadgeBaseClassName).not.toContain("rounded")
    expect(prBadgeClassName).not.toContain("rounded")
    // Base must not set bg/border/ink — tones own those (alarm fill must win).
    expect(ui.statusTag).not.toContain("bg-transparent")
    expect(ui.statusTag).not.toContain("border-ink")
    expect(ui.statusTagAlarm).toContain("bg-lane-attention")
    expect(ui.statusTagAlarm).toContain("border-lane-attention")
    expect(ui.statusTagPlain).toContain("border-ink")
    expect(ui.statusTagPlain).toContain("bg-transparent")
    expect(statusBadgeClassNameForStatus("COMPLETE")).toContain(
      statusBadgeBaseClassName,
    )
    expect(statusBadgeClassNameForStatus("COMPLETE")).toBe(
      cx(ui.statusTag, ui.statusTagComplete),
    )
    expect(statusBadgeClassNameForStatus("FAILED")).toBe(
      cx(ui.statusTag, ui.statusTagAlarm),
    )
    expect(statusBadgeClassNameForStatus("RUNNING")).toBe(
      cx(ui.statusTag, ui.statusTagPlain),
    )
    expect(statusBadgeClassNameForStatus("NEEDS_HUMAN")).toBe(
      cx(ui.statusTag, ui.statusTagAlarm),
    )
    expect(statusBadgeClassNameForStatus("NEEDS_HUMAN_REVIEW")).toBe(
      cx(ui.statusTag, ui.statusTagAlarm),
    )
  })

  test("Waiting for blockers and worker slot share hold treatment, distinct from Queued", () => {
    const blockers = statusBadgeClassNameForStatus("WAITING_FOR_BLOCKERS")
    const workerSlot = statusBadgeClassNameForStatus("WAITING_FOR_WORKER_SLOT")
    const queued = statusBadgeClassNameForStatus("QUEUED")
    const running = statusBadgeClassNameForStatus("RUNNING")

    expect(blockers).toBe(cx(ui.statusTag, ui.statusTagHold))
    expect(workerSlot).toBe(cx(ui.statusTag, ui.statusTagHold))
    expect(queued).toBe(cx(ui.statusTag, ui.statusTagPlain))
    expect(running).toBe(cx(ui.statusTag, ui.statusTagPlain))

    expect(blockers).toBe(workerSlot)
    expect(blockers).not.toBe(queued)
    expect(blockers).not.toBe(running)
  })

  test("status message tone marks alarm statuses for ▲ prefix", () => {
    expect(statusMessageClassNameForStatus("WAITING_FOR_BLOCKERS")).toBe(
      ui.statusMessage,
    )
    expect(statusMessageClassNameForStatus("WAITING_FOR_WORKER_SLOT")).toBe(
      ui.statusMessage,
    )
    expect(statusMessageClassNameForStatus("QUEUED")).toBe(ui.statusMessage)
    expect(statusMessageClassNameForStatus("FAILED")).toBe(
      cx(ui.statusMessage, ui.statusMessageAlarm),
    )
    expect(statusMessageClassNameForStatus("NEEDS_HUMAN")).toBe(
      cx(ui.statusMessage, ui.statusMessageAlarm),
    )
    expect(isStatusMessageAlarm("FAILED")).toBe(true)
    expect(isStatusMessageAlarm("INTERRUPTED")).toBe(true)
    expect(isStatusMessageAlarm("NEEDS_HUMAN")).toBe(true)
    expect(isStatusMessageAlarm("NEEDS_HUMAN_REVIEW")).toBe(true)
    expect(isStatusMessageAlarm("QUEUED")).toBe(false)
    expect(isStatusMessageAlarm("RUNNING")).toBe(false)
  })

  test("promotes PR badge to Kanban header only for Needs Human with a PR", () => {
    expect(
      kanbanPullRequestBadgePlacement({
        status: "NEEDS_HUMAN",
        pullRequestNumber: 2418,
        pullRequestUrl: "https://github.com/acme/widgets/pull/2418",
      }),
    ).toBe("header")
    // No PR yet — keep top status badge; do not leave empty PR chrome.
    expect(
      kanbanPullRequestBadgePlacement({
        status: "NEEDS_HUMAN",
        pullRequestNumber: null,
        pullRequestUrl: null,
      }),
    ).toBe("outcome")
    // Non–Needs Human tickets keep outcome PR placement.
    expect(
      kanbanPullRequestBadgePlacement({
        status: "RUNNING",
        pullRequestNumber: 17,
        pullRequestUrl: "https://github.com/acme/widgets/pull/17",
      }),
    ).toBe("outcome")
    expect(
      kanbanPullRequestBadgePlacement({
        status: "NEEDS_HUMAN_REVIEW",
        pullRequestNumber: 17,
        pullRequestUrl: "https://github.com/acme/widgets/pull/17",
      }),
    ).toBe("outcome")
    expect(
      kanbanPullRequestBadgePlacement({
        status: "COMPLETE",
        pullRequestNumber: 17,
        pullRequestUrl: "https://github.com/acme/widgets/pull/17",
      }),
    ).toBe("outcome")
  })
})
