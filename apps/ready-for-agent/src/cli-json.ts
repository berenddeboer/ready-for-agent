import { Runtime, Schema } from "effect"

/** CLI-owned envelope version for finite operator commands. */
export const CLI_SCHEMA_VERSION = 1 as const

/**
 * Finite operator commands that emit one versioned JSON document.
 * Long-running `start` is intentionally excluded.
 */
export type FiniteCommandName = "add"

/** Canonical Repository identity shared across finite CLI JSON documents. */
type CanonicalRepositoryIdentity = {
  readonly id: string
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}

export type AddSuccessDocument = {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION
  readonly command: "add"
  readonly repository: CanonicalRepositoryIdentity
  readonly localPath: string
  readonly isBare: boolean
}

type CommandErrorBody = {
  readonly code: string
  readonly message: string
}

export type CommandErrorDocument = {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION
  readonly command: FiniteCommandName
  readonly error: CommandErrorBody
}

/** Compact single-line JSON (no pretty-print whitespace). */
export const encodeCompactJson = (value: unknown): string =>
  JSON.stringify(value)

export const buildAddSuccessDocument = (added: {
  readonly id: string
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
  readonly localPath: string
  readonly isBare: boolean
}): AddSuccessDocument => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  command: "add",
  repository: {
    id: added.id,
    forge: added.forge,
    forgeHost: added.forgeHost,
    projectPath: added.projectPath,
  },
  localPath: added.localPath,
  isBare: added.isBare,
})

export const buildCommandErrorDocument = (options: {
  readonly command: FiniteCommandName
  readonly code: string
  readonly message: string
}): CommandErrorDocument => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  command: options.command,
  error: {
    code: options.code,
    message: options.message,
  },
})

const FiniteCommandNameSchema = Schema.Literals(["add"])

/**
 * Expected finite-command failure. Marked as already reported so
 * `BunRuntime.runMain` does not pretty-print a multi-frame stack after the
 * CLI writes the versioned JSON error document once on stderr.
 */
export class FiniteCommandFailed extends Schema.TaggedErrorClass<FiniteCommandFailed>()(
  "FiniteCommandFailed",
  {
    command: FiniteCommandNameSchema,
    code: Schema.String,
    message: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false

  get document(): CommandErrorDocument {
    return buildCommandErrorDocument({
      command: this.command,
      code: this.code,
      message: this.message,
    })
  }
}

/** Map LocalGit tagged failures to stable CLI-owned error codes. */
export const localGitErrorCode = (tag: string): string => {
  switch (tag) {
    case "PathNotFound":
      return "PATH_NOT_FOUND"
    case "NotADirectory":
      return "NOT_A_DIRECTORY"
    case "NotAGitRepository":
      return "NOT_A_GIT_REPOSITORY"
    case "NoForgeRemote":
      return "NO_FORGE_REMOTE"
    default:
      return "LOCAL_GIT_ERROR"
  }
}
