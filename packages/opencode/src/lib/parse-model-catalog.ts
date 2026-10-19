import { Exit, Schema } from "effect"
import type { AgentModel } from "@ready-for-agent/agent-backend"

/**
 * One V2 `GET /api/model` variant. Thinking Levels are these ids, in order.
 * Extra settings are ignored; a map (the pre-V2 `variants` object) does not
 * decode.
 */
const ModelVariant = Schema.Struct({
  id: Schema.NonEmptyString,
})

/**
 * Boundary shape for one catalog entry. `id` is the catalog model identity
 * (it may contain slashes). `modelID` is the provider wire id and can differ;
 * it is required so a partial object is not treated as a model, and it is not
 * the executable selector.
 */
const ModelInfo = Schema.Struct({
  id: Schema.NonEmptyString,
  modelID: Schema.NonEmptyString,
  providerID: Schema.NonEmptyString,
  name: Schema.String,
  enabled: Schema.Boolean,
  variants: Schema.Array(ModelVariant),
})

/** V2 list envelope. `location.directory` is the catalog's project directory. */
const ModelListEnvelope = Schema.Struct({
  location: Schema.Struct({
    directory: Schema.String,
  }),
  data: Schema.Array(ModelInfo),
})

const decodeModelListEnvelope = Schema.decodeUnknownExit(ModelListEnvelope)

export type ParsedOpencodeModelCatalog =
  | { readonly kind: "ok"; readonly models: ReadonlyArray<AgentModel> }
  | { readonly kind: "empty" }
  | { readonly kind: "malformed"; readonly reason: string }

/** Provider ends at the first slash and cannot contain `#`. */
const PROVIDER_FORBIDDEN = /[/#]/
/** Model identity may contain slashes and cannot contain the variant mark. */
const MODEL_FORBIDDEN = /#/

const malformed = (reason: string): ParsedOpencodeModelCatalog => ({
  kind: "malformed",
  reason,
})

export const OPENCODE_CATALOG_MALFORMED_MESSAGE = (detail: string): string =>
  `OpenCode could not read its model catalog (${detail}). Recheck Agent Backend.`

export const OPENCODE_CATALOG_EMPTY_MESSAGE =
  "OpenCode model catalog has no enabled models for this directory. Connect a provider or enable a model, then Recheck Agent Backend."

/**
 * Project `opencode api get /api/model` stdout into selectable Agent Models.
 *
 * Selectable entries are `enabled: true`. The executable id is
 * `providerID/id`, which is what `opencode models` prints, including model
 * ids that themselves contain slashes. Thinking Levels are variant ids.
 * Disabled entries are omitted. An enabled model with no variants stays
 * selectable and advertises no Thinking Levels.
 */
export const parseOpencodeModelCatalog = (
  stdout: string,
): ParsedOpencodeModelCatalog => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return malformed("stdout is empty")
  }

  let json: unknown
  try {
    json = JSON.parse(trimmed) as unknown
  } catch {
    return malformed("stdout is not JSON")
  }

  const decoded = decodeModelListEnvelope(json)
  if (Exit.isFailure(decoded)) {
    return malformed("response does not match the V2 /api/model envelope")
  }

  const models: AgentModel[] = []
  const seen = new Set<string>()
  for (const entry of decoded.value.data) {
    if (!entry.enabled) {
      continue
    }
    const providerID = entry.providerID.trim()
    const modelId = entry.id.trim()
    if (
      providerID.length === 0 ||
      modelId.length === 0 ||
      entry.modelID.trim().length === 0 ||
      PROVIDER_FORBIDDEN.test(providerID) ||
      MODEL_FORBIDDEN.test(modelId)
    ) {
      return malformed("an enabled model has no usable provider/model identity")
    }

    const id = `${providerID}/${modelId}`
    if (seen.has(id)) {
      continue
    }
    seen.add(id)

    const thinkingLevels: string[] = []
    const seenLevels = new Set<string>()
    for (const variant of entry.variants) {
      const level = variant.id.trim()
      if (level.length === 0) {
        return malformed("an enabled model has a blank variant id")
      }
      if (seenLevels.has(level)) {
        continue
      }
      seenLevels.add(level)
      thinkingLevels.push(level)
    }

    const name = entry.name.trim()
    models.push(
      name.length === 0 ? { id, thinkingLevels } : { id, name, thinkingLevels },
    )
  }

  if (models.length === 0) {
    return { kind: "empty" }
  }
  return { kind: "ok", models }
}
