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
    // Inline copy is borderless (no ink box next to mono session/worktree).
    expect(source).toContain("ui.iconBtnBare")
    expect(source).not.toMatch(/className=\{cx\(ui\.iconBtn,/)
    const textIndex = source.indexOf("title={value}")
    const buttonIndex = source.indexOf('type="button"')
    expect(textIndex).toBeGreaterThan(-1)
    expect(buttonIndex).toBeGreaterThan(textIndex)
  })

  test("shrinks long values and keeps the copy control visible (issue #733)", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/copy.tsx"),
      "utf8",
    )
    // inline-flex: safe in archive meta paragraphs and ticket flex/grid rows.
    expect(source).toContain(
      '"inline-flex min-w-0 max-w-full items-center gap-1"',
    )
    // Value shrinks; copy glyph does not.
    expect(source).toContain('"min-w-0 flex-1 truncate"')
    expect(source).toMatch(/ui\.iconBtnBare,\s*"shrink-0"/)
  })
})
