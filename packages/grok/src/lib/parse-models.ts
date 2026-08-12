import {
  GROK_4_6_THINKING_LEVELS,
  GROK_DEFAULT_THINKING_LEVELS,
} from "./types.js"

export type ParsedGrokModels = {
  readonly models: ReadonlyArray<{
    readonly id: string
    readonly thinkingLevels: ReadonlyArray<string>
  }>
  readonly authenticated: boolean
  readonly complete: boolean
}

const MODEL_LINE =
  /^\s*[*-]\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+\((?:default|.*?)\))?\s*$/

const THINKING_LEVELS_BY_MODEL: Readonly<Record<string, readonly string[]>> = {
  "grok-4.6": GROK_4_6_THINKING_LEVELS,
}

const thinkingLevelsForGrokModel = (id: string): readonly string[] =>
  THINKING_LEVELS_BY_MODEL[id] ?? GROK_DEFAULT_THINKING_LEVELS

const UNAUTHENTICATED_MARKERS = [
  /you are not authenticated/i,
  /not logged in/i,
  /please (?:log|sign) in/i,
  /authentication required/i,
  /run\s+`?grok login/i,
]

/**
 * Parse `grok models` plain-text catalog. Star and dash bullets are both
 * current catalog entries. Unauthenticated banners are treated as inspection
 * failure even when the CLI exits successfully.
 */
export const parseGrokModelsOutput = (stdout: string): ParsedGrokModels => {
  const authenticated = !UNAUTHENTICATED_MARKERS.some((marker) =>
    marker.test(stdout),
  )
  const models: Array<{ id: string; thinkingLevels: string[] }> = []
  const seen = new Set<string>()

  for (const line of stdout.split(/\r?\n/)) {
    const match = MODEL_LINE.exec(line)
    if (match === null) {
      continue
    }
    const id = match[1] ?? ""
    if (id.length === 0 || seen.has(id)) {
      continue
    }
    seen.add(id)
    models.push({
      id,
      thinkingLevels: [...thinkingLevelsForGrokModel(id)],
    })
  }

  return {
    models,
    authenticated,
    complete: models.length > 0,
  }
}
