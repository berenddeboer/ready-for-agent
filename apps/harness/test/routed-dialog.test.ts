import {
  isHarnessSettingsPath,
  isOtherRoutedDialogPath,
  isPipelineBackgroundPath,
  readHarnessSettingsHistoryState,
} from "../src/routed-dialog.ts"
import { describe, expect, test } from "bun:test"

describe("routed dialog path helpers (issue #840)", () => {
  test("identifies the Harness Settings path", () => {
    expect(isHarnessSettingsPath("/settings")).toBe(true)
    expect(isHarnessSettingsPath("/settings/")).toBe(true)
    expect(isHarnessSettingsPath("/")).toBe(false)
    expect(isHarnessSettingsPath("/repos")).toBe(false)
  })

  test("Pipeline background includes home and settings", () => {
    expect(isPipelineBackgroundPath("/")).toBe(true)
    expect(isPipelineBackgroundPath("/settings")).toBe(true)
    expect(isPipelineBackgroundPath("/repos")).toBe(false)
    expect(isPipelineBackgroundPath("/completed")).toBe(false)
  })

  test("detects other routed overlays for first-run suppression", () => {
    expect(isOtherRoutedDialogPath("/repos/abc/settings")).toBe(true)
    expect(isOtherRoutedDialogPath("/session/wi-1/telemetry")).toBe(true)
    expect(isOtherRoutedDialogPath("/settings")).toBe(false)
    expect(isOtherRoutedDialogPath("/repos")).toBe(false)
    expect(isOtherRoutedDialogPath("/")).toBe(false)
  })

  test("reads the in-app origin history marker", () => {
    expect(
      readHarnessSettingsHistoryState({
        harnessSettings: { kind: "in-app-origin" },
      }),
    ).toEqual({ kind: "in-app-origin" })
    expect(readHarnessSettingsHistoryState({})).toBeUndefined()
    expect(readHarnessSettingsHistoryState(null)).toBeUndefined()
    expect(
      readHarnessSettingsHistoryState({ harnessSettings: { kind: "other" } }),
    ).toBeUndefined()
  })
})
