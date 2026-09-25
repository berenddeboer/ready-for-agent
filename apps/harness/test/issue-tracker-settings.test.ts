import { ISSUE_TRACKERS } from "@ready-for-agent/lifecycle-model"
import {
  isTrackerOnlyKindSelectableFor,
  offersParentImplementAll,
  usesLinearProjectMapping,
} from "../src/issue-tracker-settings.js"
import { describe, expect, test } from "bun:test"

const values = [...ISSUE_TRACKERS, "", "unknown"]

describe("Repository settings Issue Tracker facts", () => {
  test("shows the Linear project mapping only for Linear", () => {
    for (const value of values) {
      expect(usesLinearProjectMapping(value)).toBe(value === "linear")
    }
  })

  test("hides parent Implement All for Linear and for fp, which has none yet", () => {
    expect(offersParentImplementAll("linear")).toBe(false)
    expect(offersParentImplementAll("fp")).toBe(false)
    for (const tracker of ["github", "gitlab", "azure-devops", "unknown"]) {
      expect(offersParentImplementAll(tracker)).toBe(true)
    }
  })

  test("keeps only Linear when a Repository moves back to GitHub hosting", () => {
    for (const value of values) {
      expect(isTrackerOnlyKindSelectableFor("github", value)).toBe(
        value === "linear",
      )
    }
  })
})
