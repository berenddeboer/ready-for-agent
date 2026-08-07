import {
  isHarnessSettingsPath,
  isOtherRoutedDialogPath,
  isPipelineBackgroundPath,
  isSessionTelemetryPath,
  markSessionTelemetryOpenedFromInApp,
  parseSessionTelemetryPath,
  readHarnessSettingsHistoryState,
  readSessionTelemetryHistoryState,
  wasSessionTelemetryOpenedFromInApp,
} from "../src/routed-dialog.ts"
import { describe, expect, test } from "bun:test"

describe("routed dialog path helpers (issues #840 / #841)", () => {
  test("identifies the Harness Settings path", () => {
    expect(isHarnessSettingsPath("/settings")).toBe(true)
    expect(isHarnessSettingsPath("/settings/")).toBe(true)
    expect(isHarnessSettingsPath("/")).toBe(false)
    expect(isHarnessSettingsPath("/repos")).toBe(false)
  })

  test("identifies Session Telemetry paths and Work Item IDs", () => {
    expect(isSessionTelemetryPath("/session/wi-1/telemetry")).toBe(true)
    expect(isSessionTelemetryPath("/session/wi-1/telemetry/")).toBe(true)
    expect(parseSessionTelemetryPath("/session/wi-abc/telemetry")).toEqual({
      workItemId: "wi-abc",
    })
    expect(isSessionTelemetryPath("/session//telemetry")).toBe(false)
    expect(isSessionTelemetryPath("/session/wi-1")).toBe(false)
    expect(isSessionTelemetryPath("/settings")).toBe(false)
    expect(parseSessionTelemetryPath("/repos")).toBeUndefined()
  })

  test("Pipeline background includes home, settings, and session telemetry", () => {
    expect(isPipelineBackgroundPath("/")).toBe(true)
    expect(isPipelineBackgroundPath("/settings")).toBe(true)
    expect(isPipelineBackgroundPath("/session/wi-1/telemetry")).toBe(true)
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

  test("reads the in-app origin history marker for Settings", () => {
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

  test("reads Session Telemetry history marker with optional sessionId", () => {
    expect(
      readSessionTelemetryHistoryState({
        sessionTelemetry: { kind: "in-app-origin", sessionId: "ses_1" },
      }),
    ).toEqual({ kind: "in-app-origin", sessionId: "ses_1" })
    expect(
      readSessionTelemetryHistoryState({
        sessionTelemetry: { kind: "in-app-origin" },
      }),
    ).toEqual({ kind: "in-app-origin" })
    expect(readSessionTelemetryHistoryState({})).toBeUndefined()
    expect(
      readSessionTelemetryHistoryState({
        sessionTelemetry: { kind: "other" },
      }),
    ).toBeUndefined()
  })

  test("document-session flag tracks explicit Session Telemetry opens", () => {
    // Module state may already be set from prior tests in this process; the
    // mark function is the public seam used by Pipeline openers.
    markSessionTelemetryOpenedFromInApp()
    expect(wasSessionTelemetryOpenedFromInApp()).toBe(true)
  })
})
