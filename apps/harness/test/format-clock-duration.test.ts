import { formatClockDuration } from "../src/format-clock-duration.js"
import { describe, expect, test } from "bun:test"

describe("formatClockDuration", () => {
  test("clamps negative durations to 0s in both styles", () => {
    expect(formatClockDuration({ ms: -1, style: "compact" })).toBe("0s")
    expect(formatClockDuration({ ms: -1_500, style: "spaced" })).toBe("0s")
  })

  test("formats zero as 0s in both styles", () => {
    expect(formatClockDuration({ ms: 0, style: "compact" })).toBe("0s")
    expect(formatClockDuration({ ms: 0, style: "spaced" })).toBe("0s")
  })

  test("rounds to the nearest second", () => {
    expect(formatClockDuration({ ms: 1_499, style: "spaced" })).toBe("1s")
    expect(formatClockDuration({ ms: 1_500, style: "compact" })).toBe("2s")
  })

  test("rounds up across a minute boundary", () => {
    expect(formatClockDuration({ ms: 59_500, style: "compact" })).toBe("1m")
    expect(formatClockDuration({ ms: 59_500, style: "spaced" })).toBe("1m")
  })

  test("rounds up across an hour boundary", () => {
    expect(formatClockDuration({ ms: 3_599_500, style: "compact" })).toBe("1h")
    expect(formatClockDuration({ ms: 3_599_500, style: "spaced" })).toBe("1h")
  })

  test("omits trailing zero seconds and minutes", () => {
    expect(formatClockDuration({ ms: 120_000, style: "compact" })).toBe("2m")
    expect(formatClockDuration({ ms: 120_000, style: "spaced" })).toBe("2m")
    expect(formatClockDuration({ ms: 3_600_000, style: "compact" })).toBe("1h")
    expect(formatClockDuration({ ms: 3_600_000, style: "spaced" })).toBe("1h")
  })

  test("omits seconds at hour scale", () => {
    expect(
      formatClockDuration({
        ms: 3_600_000 + 5 * 60_000 + 30_000,
        style: "compact",
      }),
    ).toBe("1h5m")
    expect(
      formatClockDuration({
        ms: 3_600_000 + 5 * 60_000 + 30_000,
        style: "spaced",
      }),
    ).toBe("1h 5m")
  })

  test("uses compact units without spaces", () => {
    expect(formatClockDuration({ ms: 45_000, style: "compact" })).toBe("45s")
    expect(
      formatClockDuration({ ms: 4 * 60_000 + 15_000, style: "compact" }),
    ).toBe("4m15s")
    expect(
      formatClockDuration({ ms: 3_600_000 + 5 * 60_000, style: "compact" }),
    ).toBe("1h5m")
  })

  test("uses spaced units with a space between them", () => {
    expect(formatClockDuration({ ms: 45_000, style: "spaced" })).toBe("45s")
    expect(
      formatClockDuration({ ms: 4 * 60_000 + 15_000, style: "spaced" }),
    ).toBe("4m 15s")
    expect(
      formatClockDuration({ ms: 3_600_000 + 5 * 60_000, style: "spaced" }),
    ).toBe("1h 5m")
  })
})
