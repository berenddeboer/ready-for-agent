import {
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
    expect(lifecycleStepChipClassName).toContain("leg")
    expect(lifecycleStepChipClassName).not.toContain("rounded")
    expect(lifecycleStepChipClassNameForStatus("SUCCEEDED")).toBe(
      "leg leg--done",
    )
    expect(lifecycleStepChipClassNameForStatus("RUNNING")).toBe("leg leg--run")
    expect(lifecycleStepChipClassNameForStatus("QUEUED")).toBe("leg leg--next")
    expect(lifecycleStepChipClassNameForStatus("FAILED")).toBe("leg leg--fail")
    // Needs-human shares Attention fill with failures — not lane-colored "run".
    expect(lifecycleStepChipClassNameForStatus("NEEDS_HUMAN")).toBe(
      "leg leg--fail",
    )
    expect(lifecycleStepChipClassNameForStatus("NEEDS_HUMAN_REVIEW")).toBe(
      "leg leg--fail",
    )
  })

  test("status tags and PR badge use Interchange component classes", () => {
    expect(statusBadgeBaseClassName).toBe("status-tag")
    expect(prBadgeClassName).toBe("pr-badge")
    expect(statusBadgeBaseClassName).not.toContain("rounded")
    expect(prBadgeClassName).not.toContain("rounded")
    expect(statusBadgeClassNameForStatus("COMPLETE")).toContain(
      statusBadgeBaseClassName,
    )
    expect(statusBadgeClassNameForStatus("COMPLETE")).toContain(
      "status-tag--complete",
    )
    expect(statusBadgeClassNameForStatus("FAILED")).toContain(
      "status-tag--alarm",
    )
    expect(statusBadgeClassNameForStatus("RUNNING")).toContain(
      "status-tag--plain",
    )
    expect(statusBadgeClassNameForStatus("NEEDS_HUMAN")).toContain(
      "status-tag--alarm",
    )
    expect(statusBadgeClassNameForStatus("NEEDS_HUMAN_REVIEW")).toContain(
      "status-tag--alarm",
    )
  })

  test("Waiting for blockers and worker slot share hold treatment, distinct from Queued", () => {
    const blockers = statusBadgeClassNameForStatus("WAITING_FOR_BLOCKERS")
    const workerSlot = statusBadgeClassNameForStatus("WAITING_FOR_WORKER_SLOT")
    const queued = statusBadgeClassNameForStatus("QUEUED")
    const running = statusBadgeClassNameForStatus("RUNNING")

    expect(blockers).toContain("status-tag--hold")
    expect(workerSlot).toContain("status-tag--hold")
    expect(queued).toContain("status-tag--plain")
    expect(running).toContain("status-tag--plain")

    expect(blockers).toBe(workerSlot)
    expect(blockers).not.toBe(queued)
    expect(blockers).not.toBe(running)
  })

  test("status message tone marks alarm statuses for ▲ prefix", () => {
    expect(statusMessageClassNameForStatus("WAITING_FOR_BLOCKERS")).toBe(
      "status-message",
    )
    expect(statusMessageClassNameForStatus("WAITING_FOR_WORKER_SLOT")).toBe(
      "status-message",
    )
    expect(statusMessageClassNameForStatus("QUEUED")).toBe("status-message")
    expect(statusMessageClassNameForStatus("FAILED")).toBe(
      "status-message status-message--alarm",
    )
    expect(statusMessageClassNameForStatus("NEEDS_HUMAN")).toBe(
      "status-message status-message--alarm",
    )
  })
})
