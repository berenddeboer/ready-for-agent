import type { AgentModel } from "@ready-for-agent/agent-backend"

export type CodexCatalogProjection =
  | { readonly kind: "ok"; readonly models: ReadonlyArray<AgentModel> }
  | { readonly kind: "empty" }
  | { readonly kind: "malformed"; readonly reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const thinkingLevelsFrom = (
  rawEfforts: unknown,
  effortKey: "reasoningEffort" | "effort",
): ReadonlyArray<string> => {
  if (!Array.isArray(rawEfforts)) {
    return []
  }
  const seen = new Set<string>()
  const levels: string[] = []
  for (const entry of rawEfforts) {
    const effort = isRecord(entry) ? nonEmptyString(entry[effortKey]) : null
    if (effort === null || seen.has(effort)) {
      continue
    }
    seen.add(effort)
    levels.push(effort)
  }
  return levels
}

const toAgentModel = (input: {
  readonly id: string
  readonly name: string | null
  readonly thinkingLevels: ReadonlyArray<string>
}): AgentModel =>
  input.name === null
    ? { id: input.id, thinkingLevels: input.thinkingLevels }
    : {
        id: input.id,
        name: input.name,
        thinkingLevels: input.thinkingLevels,
      }

const finish = (models: ReadonlyArray<AgentModel>): CodexCatalogProjection =>
  models.length === 0 ? { kind: "empty" } : { kind: "ok", models }

/**
 * Normalize one app-server `model/list` page (or a concatenated `data` array)
 * to AgentModel. Uses `model` as the executable id, `displayName` as the
 * label, and `supportedReasoningEfforts[].reasoningEffort` as open tokens.
 * Hidden entries are dropped. Order is preserved; duplicate ids keep the
 * first advertised entry.
 */
export const projectAppServerModelList = (
  payload: unknown,
): CodexCatalogProjection => {
  if (!isRecord(payload)) {
    return {
      kind: "malformed",
      reason: "model/list response is not an object",
    }
  }
  if (!Array.isArray(payload.data)) {
    return {
      kind: "malformed",
      reason: "model/list data is not an array",
    }
  }

  const seen = new Set<string>()
  const models: AgentModel[] = []
  for (const entry of payload.data) {
    if (!isRecord(entry)) {
      continue
    }
    if (entry.hidden === true) {
      continue
    }
    const id = nonEmptyString(entry.model)
    if (id === null || seen.has(id)) {
      continue
    }
    seen.add(id)
    models.push(
      toAgentModel({
        id,
        name: nonEmptyString(entry.displayName),
        thinkingLevels: thinkingLevelsFrom(
          entry.supportedReasoningEfforts,
          "reasoningEffort",
        ),
      }),
    )
  }
  return finish(models)
}

type BundledCandidate = {
  readonly index: number
  readonly priority: number
  readonly model: AgentModel
}

const bundledPriority = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.MAX_SAFE_INTEGER

/**
 * Project `codex debug models --bundled` JSON `{models:[...]}` the way the
 * Codex picker does for a non-ChatGPT custom provider: visibility `list`,
 * `supported_in_api`, priority order. This is the CLI's shipped catalog, not
 * an enumeration of arbitrary custom-provider deployment IDs.
 */
export const projectBundledDebugModels = (
  payload: unknown,
): CodexCatalogProjection => {
  let parsed = payload
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload) as unknown
    } catch {
      return {
        kind: "malformed",
        reason: "bundled models output is not JSON",
      }
    }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    return {
      kind: "malformed",
      reason: "bundled models output is missing a models array",
    }
  }

  const seen = new Set<string>()
  const candidates: BundledCandidate[] = []
  for (const [index, entry] of parsed.models.entries()) {
    if (!isRecord(entry)) {
      continue
    }
    if (nonEmptyString(entry.visibility) !== "list") {
      continue
    }
    if (entry.supported_in_api !== true) {
      continue
    }
    const id = nonEmptyString(entry.slug)
    if (id === null || seen.has(id)) {
      continue
    }
    seen.add(id)
    candidates.push({
      index,
      priority: bundledPriority(entry.priority),
      model: toAgentModel({
        id,
        name: nonEmptyString(entry.display_name),
        thinkingLevels: thinkingLevelsFrom(
          entry.supported_reasoning_levels,
          "effort",
        ),
      }),
    })
  }

  candidates.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority
    }
    return left.index - right.index
  })
  return finish(candidates.map((candidate) => candidate.model))
}
