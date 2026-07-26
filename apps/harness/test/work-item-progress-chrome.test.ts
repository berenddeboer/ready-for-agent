import {
  jobsProgressMinTextClassName,
  lifecycleStepChipClassName,
  prBadgeClassName,
  statusBadgeBaseClassName,
  statusBadgeClassNameForStatus,
  statusMessageClassNameForStatus,
} from "../src/work-item-progress-chrome.js"
import { describe, expect, test } from "bun:test"

const forbiddenSubXsRem = ["0.6rem", "0.65rem", "0.7rem"] as const

function assertMinTextXs(className: string) {
  expect(className).toContain(jobsProgressMinTextClassName)
  expect(className).toContain("text-xs")
  for (const rem of forbiddenSubXsRem) {
    expect(className).not.toContain(rem)
  }
}

describe("work-item-progress-chrome", () => {
  test("lifecycle step chips use shared text-xs minimum (no sub-xs rem)", () => {
    assertMinTextXs(lifecycleStepChipClassName)
    expect(lifecycleStepChipClassName).not.toContain("rounded")
    expect(lifecycleStepChipClassName).toContain("border")
  })

  test("status badge base and PR badge share text-xs minimum", () => {
    assertMinTextXs(statusBadgeBaseClassName)
    assertMinTextXs(prBadgeClassName)
    expect(statusBadgeBaseClassName).not.toContain("rounded")
    expect(prBadgeClassName).not.toContain("rounded")
    expect(statusBadgeBaseClassName).toContain("border")
    expect(prBadgeClassName).toContain("border")
    expect(statusBadgeClassNameForStatus("COMPLETE")).toContain(
      statusBadgeBaseClassName,
    )
    assertMinTextXs(statusBadgeClassNameForStatus("COMPLETE"))
    assertMinTextXs(statusBadgeClassNameForStatus("FAILED"))
    assertMinTextXs(statusBadgeClassNameForStatus("RUNNING"))
  })

  test("Waiting for blockers badge tone is distinct from Worker Slot and Queued", () => {
    const blockers = statusBadgeClassNameForStatus("WAITING_FOR_BLOCKERS")
    const workerSlot = statusBadgeClassNameForStatus("WAITING_FOR_WORKER_SLOT")
    const queued = statusBadgeClassNameForStatus("QUEUED")
    const running = statusBadgeClassNameForStatus("RUNNING")

    expect(blockers).toContain("bg-teal-wash")
    expect(blockers).toContain("text-teal")
    expect(workerSlot).toContain("bg-violet-wash")
    expect(workerSlot).toContain("text-violet-800")
    expect(queued).toContain("bg-oxblood-wash")
    expect(queued).toContain("text-oxblood")

    expect(blockers).not.toBe(workerSlot)
    expect(blockers).not.toBe(queued)
    expect(blockers).not.toBe(running)
    expect(workerSlot).not.toBe(queued)
    assertMinTextXs(blockers)
    assertMinTextXs(workerSlot)
  })

  test("status message tone matches wait-hold badges", () => {
    expect(statusMessageClassNameForStatus("WAITING_FOR_BLOCKERS")).toBe(
      "text-teal",
    )
    expect(statusMessageClassNameForStatus("WAITING_FOR_WORKER_SLOT")).toBe(
      "text-violet-800",
    )
    expect(statusMessageClassNameForStatus("QUEUED")).toBe("text-oxblood-deep")
    expect(statusMessageClassNameForStatus("FAILED")).toBe("text-oxblood-deep")
  })
})
