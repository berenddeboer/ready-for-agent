import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

describe("Copy component", () => {
  test("renders text with a right-side copy control that writes full value", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/copy.tsx"),
      "utf8",
    )
    expect(source).toContain("export function Copy")
    expect(source).toContain("showValue = true")
    expect(source).toContain("navigator.clipboard.writeText(value)")
    expect(source).toContain("title={value}")
    expect(source).toContain("truncate")
    expect(source).toContain('aria-label={copied ? "Copied" : "Copy"}')
    const textIndex = source.indexOf("title={value}")
    const buttonIndex = source.indexOf('type="button"')
    expect(textIndex).toBeGreaterThan(-1)
    expect(buttonIndex).toBeGreaterThan(textIndex)
  })
})
