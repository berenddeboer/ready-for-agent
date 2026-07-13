import {
  defaultKeymaxxerSidecarPort,
  keymaxxerSidecarPortFromEnvironment,
} from "../src/main.js"
import { describe, expect, test } from "bun:test"

describe("Keymaxxer development sidecar", () => {
  test("uses a fixed overridable port and rejects invalid values", () => {
    expect(keymaxxerSidecarPortFromEnvironment({})).toBe(
      defaultKeymaxxerSidecarPort,
    )
    expect(
      keymaxxerSidecarPortFromEnvironment({ KEYMAXXER_SIDECAR_PORT: "6042" }),
    ).toBe(6042)
    expect(() =>
      keymaxxerSidecarPortFromEnvironment({ KEYMAXXER_SIDECAR_PORT: "0" }),
    ).toThrow("KEYMAXXER_SIDECAR_PORT")
  })
})
