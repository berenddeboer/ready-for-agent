import {
  advertisedThinkingLevelsText,
  canonicalOptionalSetting,
  findCatalogEntry,
  thinkingLevelNotAdvertisedMessage,
  validateCatalogSelection,
} from "../src/lib/catalog-selection.js"
import { describe, expect, it } from "bun:test"

const flash = {
  id: "opencode/deepseek-v4-flash",
  thinkingLevels: ["low", "high", "max"],
} as const

const noLevels = {
  id: "opencode/gpt-5",
  thinkingLevels: [] as const,
}

const catalog = [flash, noLevels]

describe("canonicalOptionalSetting", () => {
  it("treats null, undefined, empty, and whitespace as unset", () => {
    expect(canonicalOptionalSetting(null)).toBeNull()
    expect(canonicalOptionalSetting(undefined)).toBeNull()
    expect(canonicalOptionalSetting("")).toBeNull()
    expect(canonicalOptionalSetting("   ")).toBeNull()
  })

  it("returns the trimmed value without mutating the input", () => {
    const raw = "  medium  "
    expect(canonicalOptionalSetting(raw)).toBe("medium")
    expect(raw).toBe("  medium  ")
  })
})

describe("findCatalogEntry", () => {
  it("matches a trimmed model id against complete catalog entries", () => {
    expect(findCatalogEntry(catalog, "  opencode/deepseek-v4-flash  ")).toEqual(
      flash,
    )
  })

  it("returns undefined when the model is absent or unset", () => {
    expect(findCatalogEntry(catalog, "sonnet")).toBeUndefined()
    expect(findCatalogEntry(catalog, "   ")).toBeUndefined()
    expect(findCatalogEntry(catalog, null)).toBeUndefined()
  })
})

describe("validateCatalogSelection", () => {
  it("reports a model absent from the current catalog", () => {
    expect(
      validateCatalogSelection({
        catalogEntry: undefined,
        thinkingLevel: "high",
      }),
    ).toEqual({ _tag: "model_absent" })
  })

  it("accepts a valid model with a null Thinking Level", () => {
    expect(
      validateCatalogSelection({
        catalogEntry: flash,
        thinkingLevel: null,
      }),
    ).toEqual({ _tag: "valid_null_thinking_level", model: flash })
  })

  it("treats whitespace-only Thinking Levels as null", () => {
    expect(
      validateCatalogSelection({
        catalogEntry: flash,
        thinkingLevel: "  \t  ",
      }),
    ).toEqual({ _tag: "valid_null_thinking_level", model: flash })
  })

  it("accepts a Thinking Level the model advertises", () => {
    expect(
      validateCatalogSelection({
        catalogEntry: flash,
        thinkingLevel: "  high  ",
      }),
    ).toEqual({
      _tag: "valid_thinking_level",
      model: flash,
      thinkingLevel: "high",
    })
  })

  it("rejects a Thinking Level the model does not advertise", () => {
    expect(
      validateCatalogSelection({
        catalogEntry: flash,
        thinkingLevel: "medium",
      }),
    ).toEqual({
      _tag: "thinking_level_absent",
      model: flash,
      thinkingLevel: "medium",
    })
  })

  it("accepts null and rejects every non-null level when the model offers none", () => {
    expect(
      validateCatalogSelection({
        catalogEntry: noLevels,
        thinkingLevel: null,
      }),
    ).toEqual({ _tag: "valid_null_thinking_level", model: noLevels })
    expect(
      validateCatalogSelection({
        catalogEntry: noLevels,
        thinkingLevel: "low",
      }),
    ).toEqual({
      _tag: "thinking_level_absent",
      model: noLevels,
      thinkingLevel: "low",
    })
  })

  it("does not default or substitute a missing Thinking Level", () => {
    const result = validateCatalogSelection({
      catalogEntry: flash,
      thinkingLevel: undefined,
    })
    expect(result).toEqual({
      _tag: "valid_null_thinking_level",
      model: flash,
    })
    expect(result._tag === "valid_null_thinking_level").toBe(true)
  })
})

describe("thinking-level operator copy", () => {
  it("names advertised levels when the model offers some", () => {
    expect(advertisedThinkingLevelsText(["low", "high", "max"])).toBe(
      "Advertised levels: low, high, max.",
    )
    expect(
      thinkingLevelNotAdvertisedMessage({
        role: "Build",
        thinkingLevel: "medium",
        model: flash.id,
        backendLabel: "OpenCode",
        advertised: flash.thinkingLevels,
        guidance:
          "Choose an advertised level or clear the field to use the backend/model default.",
      }),
    ).toBe(
      'Build Thinking Level "medium" is not offered by Agent Model "opencode/deepseek-v4-flash" on OpenCode. Advertised levels: low, high, max. Choose an advertised level or clear the field to use the backend/model default.',
    )
  })

  it("states that the model offers no Thinking Levels", () => {
    expect(advertisedThinkingLevelsText([])).toBe(
      "That model offers no Thinking Levels.",
    )
  })
})
