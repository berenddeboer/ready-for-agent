import {
  parseStatisticsWindow,
  statisticsWindowBounds,
} from "../src/statistics-window.js"
import { describe, expect, test } from "bun:test"

describe("statistics completion windows", () => {
  test("weeks start on local Monday, including Sunday and a year boundary", () => {
    const sunday = new Date(2027, 0, 3, 15, 30)
    expect(statisticsWindowBounds("this-week", sunday)).toEqual({
      from: new Date(2026, 11, 28).toISOString(),
      to: sunday.toISOString(),
    })
    expect(statisticsWindowBounds("last-week", sunday)).toEqual({
      from: new Date(2026, 11, 21).toISOString(),
      to: new Date(2026, 11, 28).toISOString(),
    })
    const monday = new Date(2027, 0, 4)
    expect(statisticsWindowBounds("last-week", monday)).toEqual({
      from: new Date(2026, 11, 28).toISOString(),
      to: monday.toISOString(),
    })
  })

  test("months use calendar boundaries rather than rolling thirty-day durations", () => {
    const march = new Date(2028, 2, 15, 12)
    expect(statisticsWindowBounds("last-month", march)).toEqual({
      from: new Date(2028, 1, 1).toISOString(),
      to: new Date(2028, 2, 1).toISOString(),
    })
    expect(statisticsWindowBounds("this-month", march)).toEqual({
      from: new Date(2028, 2, 1).toISOString(),
      to: march.toISOString(),
    })
    expect(statisticsWindowBounds("last-month", new Date(2027, 0, 15))).toEqual(
      {
        from: new Date(2026, 11, 1).toISOString(),
        to: new Date(2027, 0, 1).toISOString(),
      },
    )
  })

  test("rolling windows and all time keep their existing semantics", () => {
    const now = new Date(2026, 9, 29, 14, 20)
    expect(statisticsWindowBounds("7", now)).toEqual({
      from: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      to: now.toISOString(),
    })
    expect(statisticsWindowBounds("all", now)).toEqual({
      from: undefined,
      to: now.toISOString(),
    })
  })

  test("accepts calendar URL values and TanStack's numeric values, defaulting invalid input", () => {
    expect(parseStatisticsWindow("last-month")).toBe("last-month")
    expect(parseStatisticsWindow("this-week")).toBe("this-week")
    expect(parseStatisticsWindow(7)).toBe("7")
    expect(parseStatisticsWindow("90")).toBe("90")
    expect(parseStatisticsWindow(28)).toBe("28")
    expect(parseStatisticsWindow(undefined)).toBe("this-week")
    expect(parseStatisticsWindow("yesterday")).toBe("this-week")
    expect(parseStatisticsWindow("")).toBe("this-week")
  })
})
