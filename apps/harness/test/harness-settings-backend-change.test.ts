import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

describe("Harness settings Agent Backend change", () => {
  test("clears model and thinking selections when Agent Backend changes", () => {
    const source = rootSource()
    expect(source).toContain(
      "const applyAgentBackendSelection = (nextBackend: string) => {",
    )
    expect(source).toContain("applyAgentBackendSelection(event.target.value)")
    expect(source).toContain('setDefaultModel("")')
    expect(source).toContain('setDefaultVariant("")')
    expect(source).toContain('setReviewModel("")')
    expect(source).toContain('setReviewVariant("")')
    expect(source).toContain(
      "if (nextBackend === savedAgentBackend && config.data) {",
    )
    expect(source).toContain('setDefaultModel(config.data.defaultModel ?? "")')
    expect(source).toContain(
      'setDefaultVariant(config.data.defaultThinkingLevel ?? "")',
    )
    expect(source).toContain('setReviewModel(config.data.reviewModel ?? "")')
    expect(source).toContain(
      'setReviewVariant(config.data.reviewThinkingLevel ?? "")',
    )
    expect(source).toContain("required={!backendChanging}")
    expect(source).toContain("disabled={backendChanging}")
    expect(source).toContain("defaultModel: backendChanging")
    expect(source).toContain("defaultThinkingLevel: backendChanging")
    expect(source).toContain("reviewModel: backendChanging")
    expect(source).toContain("reviewThinkingLevel: backendChanging")
    expect(source).not.toMatch(
      /onChange=\{\(event\) =>\s*setSelectedAgentBackend\(event\.target\.value\)\s*\}/,
    )
  })
})
