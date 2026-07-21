import type { OpencodeModel } from "./types.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Parse `opencode models --verbose` stdout: alternating model id lines and
 * multi-line JSON objects that include a `variants` map.
 */
export const parseVerboseModelsOutput = (
  stdout: string,
): ReadonlyArray<OpencodeModel> => {
  const models: OpencodeModel[] = []
  const lines = stdout.split(/\r?\n/)
  let index = 0

  while (index < lines.length) {
    const id = lines[index]?.trim() ?? ""
    index += 1
    if (id.length === 0 || !id.includes("/")) {
      continue
    }

    while (index < lines.length && (lines[index]?.trim() ?? "").length === 0) {
      index += 1
    }

    if (index >= lines.length || (lines[index]?.trim() ?? "") !== "{") {
      models.push({ id, variants: [] })
      continue
    }

    let depth = 0
    const jsonLines: string[] = []
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? ""
      jsonLines.push(line)
      for (const character of line) {
        if (character === "{") depth += 1
        else if (character === "}") depth -= 1
      }
      if (depth === 0) {
        index += 1
        break
      }
    }

    try {
      const parsed: unknown = JSON.parse(jsonLines.join("\n"))
      const variantsValue = isRecord(parsed) ? parsed.variants : undefined
      const variants = isRecord(variantsValue) ? Object.keys(variantsValue) : []
      models.push({ id, variants })
    } catch {
      models.push({ id, variants: [] })
    }
  }

  return models
}
