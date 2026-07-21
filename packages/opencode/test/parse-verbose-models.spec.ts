import { parseVerboseModelsOutput } from "../src/lib/parse-verbose-models.js"
import { describe, expect, it } from "bun:test"

describe("parseVerboseModelsOutput", () => {
  it("extracts model ids and variant keys from verbose OpenCode output", () => {
    const stdout = [
      "xai/grok-4.5",
      "{",
      '  "id": "grok-4.5",',
      '  "providerID": "xai",',
      '  "variants": {',
      '    "low": { "reasoningEffort": "low" },',
      '    "medium": { "reasoningEffort": "medium" },',
      '    "high": { "reasoningEffort": "high" }',
      "  }",
      "}",
      "xai/grok-4.3",
      "{",
      '  "id": "grok-4.3",',
      '  "variants": {',
      '    "none": { "reasoningEffort": "none" },',
      '    "low": { "reasoningEffort": "low" },',
      '    "medium": { "reasoningEffort": "medium" },',
      '    "high": { "reasoningEffort": "high" }',
      "  }",
      "}",
      "xai/grok-4.20-multi-agent-0309",
      "{",
      '  "variants": {',
      '    "low": {},',
      '    "medium": {},',
      '    "high": {},',
      '    "xhigh": {}',
      "  }",
      "}",
      "xai/non-reasoning",
      "{",
      '  "variants": {}',
      "}",
    ].join("\n")

    expect(parseVerboseModelsOutput(stdout)).toEqual([
      {
        id: "xai/grok-4.5",
        variants: ["low", "medium", "high"],
      },
      {
        id: "xai/grok-4.3",
        variants: ["none", "low", "medium", "high"],
      },
      {
        id: "xai/grok-4.20-multi-agent-0309",
        variants: ["low", "medium", "high", "xhigh"],
      },
      {
        id: "xai/non-reasoning",
        variants: [],
      },
    ])
  })

  it("skips blank lines and treats missing variants as empty", () => {
    const stdout = [
      "",
      "opencode/big-pickle",
      "{",
      '  "id": "big-pickle"',
      "}",
      "",
      "provider/only-id",
      "",
    ].join("\n")

    expect(parseVerboseModelsOutput(stdout)).toEqual([
      { id: "opencode/big-pickle", variants: [] },
      { id: "provider/only-id", variants: [] },
    ])
  })

  it("ignores lines that are not provider/model ids", () => {
    expect(parseVerboseModelsOutput("not-a-model\n{\n}\n")).toEqual([])
  })
})
