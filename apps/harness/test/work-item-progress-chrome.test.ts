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
})
