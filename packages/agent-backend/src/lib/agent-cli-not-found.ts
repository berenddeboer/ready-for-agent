const SPAWN_NOT_FOUND_CODE = "ENOENT"

const readUnknownField = (value: object, key: string): unknown =>
  key in value ? Reflect.get(value, key) : undefined

const isChildProcessSpawn = (value: object): boolean => {
  const module = readUnknownField(value, "module")
  const method = readUnknownField(value, "method")
  if (module === "ChildProcess" && method === "spawn") {
    return true
  }
  const reason = readUnknownField(value, "reason")
  if (typeof reason === "object" && reason !== null) {
    return (
      readUnknownField(reason, "module") === "ChildProcess" &&
      readUnknownField(reason, "method") === "spawn"
    )
  }
  return false
}

/**
 * Walk a nested `cause` chain and return `ENOENT` only for ChildProcess spawn.
 * FileSystem access ENOENT (missing cwd) and EACCES (not executable) have
 * different remedies and are not recognized.
 */
export const findSpawnNotFoundCode = (cause: unknown): string | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = cause
  let spawnContext = false
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (typeof current === "object") {
      if (isChildProcessSpawn(current)) {
        spawnContext = true
      }
      const code = readUnknownField(current, "code")
      if (spawnContext && code === SPAWN_NOT_FOUND_CODE) {
        return SPAWN_NOT_FOUND_CODE
      }
      current = readUnknownField(current, "cause")
      continue
    }
    break
  }
  return undefined
}

export type AgentCliNotFoundRemediationInput = {
  readonly backendLabel: string
  readonly binary: string
}

/**
 * Operator-facing copy that names the missing CLI and the Harness restart
 * remedy. The Harness cannot pick up a later install without restarting.
 */
export const formatAgentCliNotFoundRemediation = (
  input: AgentCliNotFoundRemediationInput,
): string =>
  [
    `${input.backendLabel} CLI "${input.binary}" was not found on the Harness PATH.`,
    `The Harness inherits the PATH of the shell that started it and cannot pick up a later install, upgrade, or relocation. Check with \`command -v ${input.binary}\`, then restart the Harness from a shell where it resolves.`,
  ].join("\n")
