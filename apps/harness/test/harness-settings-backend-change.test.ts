import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

describe("Harness settings Agent Backend change", () => {
  test("previews catalog and restores per-backend prefs without restart ceremony", () => {
    const source = rootSource()
    expect(source).toContain(
      "const applyAgentBackendSelection = async (nextBackend: string) => {",
    )
    expect(source).toContain(
      "void applyAgentBackendSelection(event.target.value)",
    )
    expect(source).toContain("previewAgentBackend")
    expect(source).toContain("harnessModelPrefs")
    expect(source).toContain("unfinishedWorkItemCount")
    expect(source).toContain("backendChangeBlocked")
    expect(source).toContain("Activates immediately on Save")
    expect(source).not.toContain("Cleared — choose after restart")
    expect(source).not.toContain("Takes effect after restart")
    expect(source).not.toContain("RESTART_REQUIRED")
    expect(source).toContain('defaultModel: defaultModel.trim() === ""')
  })
})
