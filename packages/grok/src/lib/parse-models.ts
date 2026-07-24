import { GROK_DEFAULT_THINKING_LEVELS } from "./types.js"

export type ParsedGrokModels = {
  readonly models: ReadonlyArray<{
    readonly id: string
    readonly thinkingLevels: ReadonlyArray<string>
  }>
  readonly authenticated: boolean
  readonly complete: boolean
}

const MODEL_LINE =
  /^\s*\*\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+\((?:default|.*?)\))?\s*$/

const UNAUTHENTICATED_MARKERS = [
  /you are not authenticated/i,
  /not logged in/i,
  /please (?:log|sign) in/i,
  /authentication required/i,
  /run\s+`?grok login/i,
]

/**
 * Parse `grok models` plain-text catalog. Unauthenticated banners are treated
 * as inspection failure even when the CLI exits successfully.
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
      thinkingLevels: [...GROK_DEFAULT_THINKING_LEVELS],
    })
  }

  return {
    models,
    authenticated,
    complete: models.length > 0,
  }
}
