import { Runtime, Schema } from "effect"

/** CLI-owned envelope version for finite operator commands. */
export const CLI_SCHEMA_VERSION = 1 as const

/**
 * Finite operator commands that emit one versioned JSON document.
 * Long-running `start` is intentionally excluded.
 */
export type FiniteCommandName = "add" | "candidates" | "status"

/** Canonical Repository identity shared across finite CLI JSON documents. */
export type CanonicalRepositoryIdentity = {
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

export type IntakeCandidateAction = "IMPLEMENT_NOW" | "QUEUE"

export type CandidatesSuccessDocument = {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION
  readonly command: "candidates"
  readonly repository: CanonicalRepositoryIdentity
  readonly issuesReconciledAt: string | null
  readonly candidates: readonly {
    readonly issueNumber: number
    readonly title: string
    readonly url: string
    readonly action: IntakeCandidateAction
  }[]
}

export type StatusLaneId =
  | "QUEUE"
  | "BUILD"
  | "REVIEW"
  | "PR"
  | "ATTENTION"
  | "MERGED"

export type StatusWorkItemRow = {
  readonly repository: CanonicalRepositoryIdentity
  readonly id: string
  readonly issueNumber: number
  readonly issueTitle: string | null
  readonly state: string
  readonly status: string
  readonly statusMessage: string | null
  readonly paused: boolean
  readonly pullRequestNumber: number | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly stateReadyAt: string
  readonly postponedUntil: string | null
}

export type StatusLane = {
  readonly id: StatusLaneId
  readonly label: string
  readonly count: number
  readonly workItems: readonly StatusWorkItemRow[]
}

export type StatusSuccessDocument = {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION
  readonly command: "status"
  readonly repository: CanonicalRepositoryIdentity | null
  readonly lanes: readonly StatusLane[]
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

export const buildCandidatesSuccessDocument = (input: {
  readonly repository: CanonicalRepositoryIdentity
  readonly issuesReconciledAt: string | null
  readonly candidates: readonly {
    readonly issueNumber: number
    readonly title: string
    readonly url: string
    readonly action: IntakeCandidateAction
  }[]
}): CandidatesSuccessDocument => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  command: "candidates",
  repository: input.repository,
  issuesReconciledAt: input.issuesReconciledAt,
  candidates: input.candidates,
})

export const toCanonicalRepositoryIdentity = (repository: {
  readonly id: string
  readonly forge: string
  readonly forgeHost: string
  readonly projectPath: string
}): CanonicalRepositoryIdentity => ({
  id: repository.id,
  forge: repository.forge,
  forgeHost: repository.forgeHost,
  projectPath: repository.projectPath,
})

export const buildStatusSuccessDocument = (options: {
  readonly repository: CanonicalRepositoryIdentity | null
  readonly lanes: readonly StatusLane[]
}): StatusSuccessDocument => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  command: "status",
  repository: options.repository,
  lanes: options.lanes,
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

const FiniteCommandNameSchema = Schema.Literals(["add", "candidates", "status"])

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
