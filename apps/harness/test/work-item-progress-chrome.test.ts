import {
  jobsProgressMinTextClassName,
  lifecycleStepChipClassName,
  prBadgeClassName,
  statusBadgeBaseClassName,
  statusBadgeClassNameForStatus,
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
    expect(lifecycleStepChipClassName).toContain("rounded")
    expect(lifecycleStepChipClassName).toContain("ring-1")
  })

  test("status badge base and PR badge share text-xs minimum", () => {
    assertMinTextXs(statusBadgeBaseClassName)
    assertMinTextXs(prBadgeClassName)
    expect(statusBadgeClassNameForStatus("COMPLETE")).toContain(
      statusBadgeBaseClassName,
    )
    assertMinTextXs(statusBadgeClassNameForStatus("COMPLETE"))
    assertMinTextXs(statusBadgeClassNameForStatus("FAILED"))
    assertMinTextXs(statusBadgeClassNameForStatus("RUNNING"))
  })
})
