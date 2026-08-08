import { getHarnessSettingsAutoOpenAction } from "../src/harness-settings-auto-open.ts"
import { describe, expect, test } from "bun:test"

describe("Harness Settings automatic open", () => {
  const configuredAvailable = {
    autoOpenAttempted: false,
    configLoaded: true,
    buildConfigured: true,
    backendStatusLoaded: true,
    defaultBackendUnavailable: false,
    otherRoutedDialogOpen: false,
    routedSettingsOpen: false,
  }

  test("opens when the configured default Agent Backend is unavailable", () => {
    expect(
      getHarnessSettingsAutoOpenAction({
        ...configuredAvailable,
        defaultBackendUnavailable: true,
      }),
    ).toBe("OPEN")
  })

  test("does not reopen after the one page-session attempt", () => {
    expect(
      getHarnessSettingsAutoOpenAction({
        ...configuredAvailable,
        autoOpenAttempted: true,
        defaultBackendUnavailable: true,
      }),
    ).toBe("NONE")
  })

  test("waits for status and suppresses competing routed dialogs without burning the attempt", () => {
    expect(
      getHarnessSettingsAutoOpenAction({
        ...configuredAvailable,
        backendStatusLoaded: false,
        defaultBackendUnavailable: true,
      }),
    ).toBe("NONE")
    expect(
      getHarnessSettingsAutoOpenAction({
        ...configuredAvailable,
        defaultBackendUnavailable: true,
        otherRoutedDialogOpen: true,
      }),
    ).toBe("NONE")
  })

  test("preserves first-run auto-open before backend status has loaded", () => {
    expect(
      getHarnessSettingsAutoOpenAction({
        ...configuredAvailable,
        buildConfigured: false,
        backendStatusLoaded: false,
      }),
    ).toBe("OPEN")
  })

  test("marks the attempt when the Settings route already owns the dialog", () => {
    expect(
      getHarnessSettingsAutoOpenAction({
        ...configuredAvailable,
        defaultBackendUnavailable: true,
        routedSettingsOpen: true,
      }),
    ).toBe("MARK_ATTEMPTED")
  })
})
