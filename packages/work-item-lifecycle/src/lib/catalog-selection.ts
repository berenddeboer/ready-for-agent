/**
 * Pure catalog selection invariant (issue #1073).
 *
 * Validates an Agent Model identity plus an optional Thinking Level against a
 * complete catalog entry. Catalog acquisition stays outside this module.
 */

export type CatalogModelEntry = {
  readonly id: string
  readonly thinkingLevels: ReadonlyArray<string>
}

/**
 * Canonical optional settings string: trim, treat empty/whitespace as null.
 * Matches persistence normalization without mutating the caller input.
 */
export const canonicalOptionalSetting = (
  value: string | null | undefined,
): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

export type CatalogSelectionResult =
  | { readonly _tag: "model_absent" }
  | {
      readonly _tag: "thinking_level_absent"
      readonly model: CatalogModelEntry
      readonly thinkingLevel: string
    }
  | {
      readonly _tag: "valid_null_thinking_level"
      readonly model: CatalogModelEntry
    }
  | {
      readonly _tag: "valid_thinking_level"
      readonly model: CatalogModelEntry
      readonly thinkingLevel: string
    }

export const findCatalogEntry = (
  catalog: ReadonlyArray<CatalogModelEntry>,
  modelId: string | null | undefined,
): CatalogModelEntry | undefined => {
  const id = canonicalOptionalSetting(modelId)
  if (id === null) {
    return undefined
  }
  return catalog.find((entry) => entry.id === id)
}

/**
 * Validate an optional Thinking Level against a complete catalog entry.
 *
 * `catalogEntry` is undefined when the Agent Model is absent from the current
 * catalog. Empty and whitespace-only Thinking Levels are treated as null.
 * An entry with `thinkingLevels: []` accepts only null.
 */
export const validateCatalogSelection = (input: {
  readonly catalogEntry: CatalogModelEntry | undefined
  readonly thinkingLevel: string | null | undefined
}): CatalogSelectionResult => {
  if (input.catalogEntry === undefined) {
    return { _tag: "model_absent" }
  }
  const thinkingLevel = canonicalOptionalSetting(input.thinkingLevel)
  if (thinkingLevel === null) {
    return {
      _tag: "valid_null_thinking_level",
      model: input.catalogEntry,
    }
  }
  if (!input.catalogEntry.thinkingLevels.includes(thinkingLevel)) {
    return {
      _tag: "thinking_level_absent",
      model: input.catalogEntry,
      thinkingLevel,
    }
  }
  return {
    _tag: "valid_thinking_level",
    model: input.catalogEntry,
    thinkingLevel,
  }
}

export const advertisedThinkingLevelsText = (
  levels: ReadonlyArray<string>,
): string =>
  levels.length === 0
    ? "That model offers no Thinking Levels."
    : `Advertised levels: ${levels.join(", ")}.`

export const thinkingLevelNotAdvertisedMessage = (input: {
  readonly role: string
  readonly thinkingLevel: string
  readonly model: string
  readonly backendLabel: string
  readonly advertised: ReadonlyArray<string>
  readonly guidance: string
}): string =>
  `${input.role} Thinking Level "${input.thinkingLevel}" is not offered by Agent Model "${input.model}" on ${input.backendLabel}. ${advertisedThinkingLevelsText(input.advertised)} ${input.guidance}`
