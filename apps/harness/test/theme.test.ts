import {
  oppositeTheme,
  parseThemeSearch,
  resolveThemeMode,
  themeToggleLabel,
  withThemePin,
} from "../src/theme"
import { describe, expect, test } from "bun:test"

describe("theme plumbing", () => {
  test("?theme= pin wins over prefers-color-scheme", () => {
    expect(resolveThemeMode("?theme=dark", false)).toBe("dark")
    expect(resolveThemeMode("?theme=light", true)).toBe("light")
    expect(resolveThemeMode("?theme=nope", true)).toBe("dark")
    expect(resolveThemeMode("", true)).toBe("dark")
    expect(resolveThemeMode("", false)).toBe("light")
  })

  test("parseThemeSearch accepts only light|dark", () => {
    expect(parseThemeSearch({ theme: "dark" })).toEqual({ theme: "dark" })
    expect(parseThemeSearch({ theme: "light" })).toEqual({ theme: "light" })
    expect(parseThemeSearch({ theme: "nope" })).toEqual({})
    expect(parseThemeSearch({})).toEqual({})
  })

  test("withThemePin preserves other search keys", () => {
    expect(withThemePin({ page: 2 }, "dark")).toEqual({
      page: 2,
      theme: "dark",
    })
  })

  test("toggle label is the target theme", () => {
    expect(themeToggleLabel("light")).toBe("Dark")
    expect(themeToggleLabel("dark")).toBe("Light")
    expect(oppositeTheme("light")).toBe("dark")
    expect(oppositeTheme("dark")).toBe("light")
  })
})
