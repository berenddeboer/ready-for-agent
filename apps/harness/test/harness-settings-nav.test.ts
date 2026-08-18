import { openHarnessSettings } from "../src/harness-settings-nav.ts"
import { wasHarnessSettingsOpenedFromInApp } from "../src/routed-dialog.ts"
import { describe, expect, test } from "bun:test"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

describe("openHarnessSettings (issue #1146)", () => {
  test("masks /settings over the current runtime location and marks in-app origin", () => {
    const calls: unknown[] = []

    openHarnessSettings({
      navigate: (options) => {
        calls.push(options)
      },
    })

    expect(wasHarnessSettingsOpenedFromInApp()).toBe(true)
    expect(calls).toHaveLength(1)
    const options = calls[0]
    expect(isRecord(options)).toBe(true)
    if (!isRecord(options)) {
      return
    }
    expect(options.to).toBe(".")
    expect(options.resetScroll).toBe(false)
    expect(isRecord(options.mask)).toBe(true)
    if (!isRecord(options.mask)) {
      return
    }
    expect(options.mask.to).toBe("/settings")
    expect(options.mask.unmaskOnReload).toBe(true)
    expect(typeof options.search).toBe("function")
    expect(typeof options.mask.search).toBe("function")
    expect(typeof options.state).toBe("function")
    if (typeof options.search === "function") {
      expect(options.search({ theme: "dark", page: 2 })).toEqual({
        theme: "dark",
        page: 2,
      })
    }
    if (typeof options.mask.search === "function") {
      expect(options.mask.search({ theme: "dark", page: 2 })).toEqual({
        theme: "dark",
      })
    }
    if (typeof options.state === "function") {
      expect(options.state({ themePin: true })).toEqual({
        themePin: true,
        harnessSettings: { kind: "in-app-origin" },
      })
    }
  })
})
