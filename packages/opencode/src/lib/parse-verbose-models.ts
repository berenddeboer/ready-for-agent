import type { OpencodeModel } from "./types.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export type ParsedVerboseModels = {
  readonly models: ReadonlyArray<OpencodeModel>
  /** False when stdout ends mid-object or otherwise looks truncated. */
  readonly complete: boolean
}

/**
 * Parse `opencode models --verbose` stdout: alternating model id lines and
 * multi-line JSON objects that include a `variants` map.
 */
export const parseVerboseModelsOutputDetailed = (
  stdout: string,
): ParsedVerboseModels => {
  const models: OpencodeModel[] = []
  const lines = stdout.split(/\r?\n/)
  let index = 0
  let complete = true

  while (index < lines.length) {
    const id = lines[index]?.trim() ?? ""
    index += 1
    if (id.length === 0 || !id.includes("/")) {
      continue
    }

    while (index < lines.length && (lines[index]?.trim() ?? "").length === 0) {
      index += 1
    }

    if (index >= lines.length) {
      models.push({ id, variants: [] })
      complete = false
      break
    }

    if ((lines[index]?.trim() ?? "") !== "{") {
      models.push({ id, variants: [] })
      continue
    }

    let depth = 0
    const jsonLines: string[] = []
    let closed = false
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? ""
      jsonLines.push(line)
      for (const character of line) {
        if (character === "{") depth += 1
        else if (character === "}") depth -= 1
      }
      if (depth === 0) {
        index += 1
        closed = true
        break
      }
    }

    if (!closed || depth !== 0) {
      complete = false
      models.push({ id, variants: [] })
      break
    }

    try {
      const parsed: unknown = JSON.parse(jsonLines.join("\n"))
      const variantsValue = isRecord(parsed) ? parsed.variants : undefined
      const variants = isRecord(variantsValue) ? Object.keys(variantsValue) : []
      models.push({ id, variants })
    } catch {
      complete = false
      models.push({ id, variants: [] })
    }
  }

  return { models, complete }
}

export const parseVerboseModelsOutput = (
  stdout: string,
): ReadonlyArray<OpencodeModel> =>
  parseVerboseModelsOutputDetailed(stdout).models
