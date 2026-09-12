import { Effect } from "effect"
import {
  type CiGateDefinitionRecord,
  InvalidRepositorySettingsError,
} from "@ready-for-agent/db-service"
import {
  type CiGateCatalogEntry,
  formatUserFacingError,
} from "@ready-for-agent/forge-contract"

export type CiGateCatalogLoad =
  | {
      readonly kind: "loaded"
      readonly definitions: readonly CiGateCatalogEntry[]
    }
  | { readonly kind: "unavailable"; readonly message: string }

export const ciGateCatalogErrorMessage = (error: unknown): string => {
  const formatted = formatUserFacingError(
    error,
    "The live CI Gate catalog could not be loaded",
  )
  return formatted.trim() === ""
    ? "The live CI Gate catalog could not be loaded"
    : formatted
}

export const resolveSelectedCiGateDefinitions = (input: {
  readonly requestedIdentities: readonly string[]
  readonly existing: readonly CiGateDefinitionRecord[]
  readonly catalog: CiGateCatalogLoad
}): Effect.Effect<
  readonly CiGateDefinitionRecord[],
  InvalidRepositorySettingsError
> => {
  const identities: string[] = []
  const seen = new Set<string>()
  for (const raw of input.requestedIdentities) {
    const identity = raw.trim()
    if (identity.length === 0) {
      return Effect.fail(
        new InvalidRepositorySettingsError({
          field: "selectedCiGateDefinitionIdentities",
          message: "CI Gate Definition identities cannot be empty",
        }),
      )
    }
    if (seen.has(identity)) {
      return Effect.fail(
        new InvalidRepositorySettingsError({
          field: "selectedCiGateDefinitionIdentities",
          message: `Duplicate CI Gate Definition identity: ${identity}`,
        }),
      )
    }
    seen.add(identity)
    identities.push(identity)
  }

  const existingByIdentity = new Map(
    input.existing.map((definition) => [definition.identity, definition]),
  )
  const catalogByIdentity = new Map(
    input.catalog.kind === "loaded"
      ? input.catalog.definitions.map((definition) => [
          definition.identity,
          definition,
        ])
      : [],
  )
  const added = identities.filter(
    (identity) => !existingByIdentity.has(identity),
  )
  if (added.length > 0 && input.catalog.kind === "unavailable") {
    return Effect.fail(
      new InvalidRepositorySettingsError({
        field: "selectedCiGateDefinitionIdentities",
        message: `Cannot add CI Gate Definitions because the live catalog could not be loaded: ${input.catalog.message}`,
      }),
    )
  }
  for (const identity of added) {
    if (!catalogByIdentity.has(identity)) {
      return Effect.fail(
        new InvalidRepositorySettingsError({
          field: "selectedCiGateDefinitionIdentities",
          message: `CI Gate Definition ${identity} is not in the current catalog. Select an active definition, or remove it from the selection.`,
        }),
      )
    }
  }

  const resolved: CiGateDefinitionRecord[] = []
  for (const identity of identities) {
    const live = catalogByIdentity.get(identity)
    if (live !== undefined) {
      resolved.push({
        identity: live.identity,
        displayLabel: live.displayLabel,
        kind: live.kind,
        diagnosticMetadata: live.diagnosticMetadata,
      })
      continue
    }
    const existing = existingByIdentity.get(identity)
    if (existing === undefined) {
      return Effect.fail(
        new InvalidRepositorySettingsError({
          field: "selectedCiGateDefinitionIdentities",
          message: `CI Gate Definition ${identity} is not in the current catalog. Select an active definition, or remove it from the selection.`,
        }),
      )
    }
    resolved.push(existing)
  }
  return Effect.succeed(resolved)
}
